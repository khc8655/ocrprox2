// Package crypto provides AES-256-GCM encryption with PBKDF2-SHA256 key derivation,
// and backwards compatibility for Python Fernet tokens used in Gen 1.
package crypto

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

var (
	ErrInvalidToken   = errors.New("crypto: invalid ciphertext or wrong key")
	ErrInvalidFernet  = errors.New("crypto: invalid fernet token")
	ErrInvalidPadding = errors.New("crypto: invalid pkcs7 padding")
)

const (
	defaultIterations = 100_000
	envelopeFormat    = "llmproxy-encrypted"
)

type EncryptedEnvelope struct {
	Format     string `json:"format"`
	Version    int    `json:"version"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       []byte `json:"salt"`
	Nonce      []byte `json:"nonce"`
	Data       []byte `json:"data"`
}

// DeriveKey derives a 32-byte key from a passphrase and salt using PBKDF2-SHA256.
func DeriveKey(passphrase string, salt []byte, iterations int) []byte {
	// Standard PBKDF2-SHA256 implementation
	prf := func(password, data []byte) []byte {
		h := hmac.New(sha256.New, password)
		h.Write(data)
		return h.Sum(nil)
	}

	key := make([]byte, 32)
	hLen := sha256.Size
	numBlocks := (len(key) + hLen - 1) / hLen

	var blockBuf [4]byte
	passBytes := []byte(passphrase)

	for block := 1; block <= numBlocks; block++ {
		binary.BigEndian.PutUint32(blockBuf[:], uint32(block))

		h := hmac.New(sha256.New, passBytes)
		h.Write(salt)
		h.Write(blockBuf[:])
		u := h.Sum(nil)

		t := make([]byte, len(u))
		copy(t, u)

		for i := 1; i < iterations; i++ {
			u = prf(passBytes, u)
			for j := 0; j < len(t); j++ {
				t[j] ^= u[j]
			}
		}

		destStart := (block - 1) * hLen
		destEnd := destStart + hLen
		if destEnd > len(key) {
			destEnd = len(key)
		}
		copy(key[destStart:destEnd], t[:destEnd-destStart])
	}

	return key
}

// Encrypt encrypts plaintext using PBKDF2-SHA256 + AES-256-GCM.
func Encrypt(plaintext []byte, passphrase string) ([]byte, error) {
	if passphrase == "" {
		return nil, errors.New("crypto: empty passphrase")
	}

	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}

	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	key := DeriveKey(passphrase, salt, defaultIterations)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)

	env := EncryptedEnvelope{
		Format:     envelopeFormat,
		Version:    1,
		KDF:        "pbkdf2-sha256",
		Iterations: defaultIterations,
		Salt:       salt,
		Nonce:      nonce,
		Data:       ciphertext,
	}

	return json.Marshal(env)
}

// Decrypt attempts to decrypt ciphertext using either Gen 2 AES-256-GCM or Gen 1 Fernet.
func Decrypt(ciphertext []byte, keyOrPassphrase string) ([]byte, error) {
	if len(ciphertext) == 0 {
		return nil, ErrInvalidToken
	}

	trimmed := bytes.TrimSpace(ciphertext)

	// 1. Try Gen 2 JSON Envelope
	if bytes.HasPrefix(trimmed, []byte(`{"format":"`+envelopeFormat+`"`)) {
		var env EncryptedEnvelope
		if err := json.Unmarshal(trimmed, &env); err == nil && env.Format == envelopeFormat {
			key := DeriveKey(keyOrPassphrase, env.Salt, env.Iterations)
			block, err := aes.NewCipher(key)
			if err != nil {
				return nil, err
			}
			gcm, err := cipher.NewGCM(block)
			if err != nil {
				return nil, err
			}
			plain, err := gcm.Open(nil, env.Nonce, env.Data, nil)
			if err != nil {
				return nil, ErrInvalidToken
			}
			return plain, nil
		}
	}

	// 2. Try Gen 1 Fernet (raw bytes or base64 encoded)
	// Check if base64 encoded
	decodedToken := ciphertext
	if b64, err := base64.URLEncoding.DecodeString(string(trimmed)); err == nil && len(b64) >= 73 && b64[0] == 0x80 {
		decodedToken = b64
	} else if b64, err := base64.StdEncoding.DecodeString(string(trimmed)); err == nil && len(b64) >= 73 && b64[0] == 0x80 {
		decodedToken = b64
	}

	if len(decodedToken) >= 73 && decodedToken[0] == 0x80 {
		plain, err := DecryptFernet(decodedToken, keyOrPassphrase)
		if err == nil {
			return plain, nil
		}
	}

	return nil, ErrInvalidToken
}

// DecryptFernet decrypts a Python cryptography.fernet token.
// Token layout:
// Version (1 byte: 0x80) | Timestamp (8 bytes) | IV (16 bytes) | Ciphertext (var) | HMAC (32 bytes)
func DecryptFernet(token []byte, keyStr string) ([]byte, error) {
	if len(token) < 73 || token[0] != 0x80 {
		return nil, ErrInvalidFernet
	}

	// Key is 32 bytes, usually base64 encoded url-safe in python
	var keyBytes []byte
	var err error
	if len(keyStr) == 44 {
		keyBytes, err = base64.URLEncoding.DecodeString(keyStr)
		if err != nil {
			keyBytes, err = base64.StdEncoding.DecodeString(keyStr)
		}
	} else if len(keyStr) == 32 {
		keyBytes = []byte(keyStr)
	}
	if err != nil || len(keyBytes) != 32 {
		return nil, fmt.Errorf("crypto: invalid fernet key length (%d)", len(keyBytes))
	}

	signingKey := keyBytes[:16]
	encryptionKey := keyBytes[16:]

	payloadLen := len(token) - 32
	payload := token[:payloadLen]
	expectedHmac := token[payloadLen:]

	// Verify HMAC-SHA256
	mac := hmac.New(sha256.New, signingKey)
	mac.Write(payload)
	computedHmac := mac.Sum(nil)
	if subtle.ConstantTimeCompare(expectedHmac, computedHmac) != 1 {
		return nil, ErrInvalidFernet
	}

	iv := token[9:25]
	ciphertext := token[25:payloadLen]

	if len(ciphertext)%aes.BlockSize != 0 {
		return nil, ErrInvalidFernet
	}

	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		return nil, err
	}

	mode := cipher.NewCBCDecrypter(block, iv)
	plaintext := make([]byte, len(ciphertext))
	mode.CryptBlocks(plaintext, ciphertext)

	// PKCS#7 unpadding
	plain, err := pkcs7Unpad(plaintext, aes.BlockSize)
	if err != nil {
		return nil, err
	}

	return plain, nil
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, ErrInvalidPadding
	}
	padLen := int(data[len(data)-1])
	if padLen == 0 || padLen > blockSize || padLen > len(data) {
		return nil, ErrInvalidPadding
	}
	for i := len(data) - padLen; i < len(data); i++ {
		if data[i] != byte(padLen) {
			return nil, ErrInvalidPadding
		}
	}
	return data[:len(data)-padLen], nil
}
