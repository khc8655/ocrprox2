package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)

func TestEncryptDecrypt_AES256GCM(t *testing.T) {
	pass := "super-secret-password-123"
	plaintext := []byte("Hello, LLMProxy2 with AES-256-GCM!")

	ciphertext, err := Encrypt(plaintext, pass)
	if err != nil {
		t.Fatalf("Encrypt error: %v", err)
	}

	decrypted, err := Decrypt(ciphertext, pass)
	if err != nil {
		t.Fatalf("Decrypt error: %v", err)
	}

	if string(decrypted) != string(plaintext) {
		t.Fatalf("got %q, want %q", string(decrypted), string(plaintext))
	}

	// Wrong password must fail
	_, err = Decrypt(ciphertext, "wrong-password")
	if err == nil {
		t.Fatalf("expected error with wrong password, got nil")
	}
}

func TestDecrypt_Fernet(t *testing.T) {
	// Construct a valid Fernet token manually
	keyBytes := make([]byte, 32)
	for i := range keyBytes {
		keyBytes[i] = byte(i + 1)
	}
	keyStr := base64.URLEncoding.EncodeToString(keyBytes)

	signingKey := keyBytes[:16]
	encryptionKey := keyBytes[16:]

	msg := []byte("Fernet test message for Gen 1 compatibility")
	// PKCS#7 pad
	padLen := aes.BlockSize - (len(msg) % aes.BlockSize)
	padded := append(msg, make([]byte, padLen)...)
	for i := len(msg); i < len(padded); i++ {
		padded[i] = byte(padLen)
	}

	iv := make([]byte, 16)
	for i := range iv {
		iv[i] = byte(i + 10)
	}

	block, err := aes.NewCipher(encryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	enc := cipher.NewCBCEncrypter(block, iv)
	ciphertext := make([]byte, len(padded))
	enc.CryptBlocks(ciphertext, padded)

	// Build token: version(0x80) + ts(8 bytes) + iv(16 bytes) + ciphertext + hmac(32 bytes)
	token := []byte{0x80}
	ts := uint64(time.Now().Unix())
	tsBytes := []byte{
		byte(ts >> 56), byte(ts >> 48), byte(ts >> 40), byte(ts >> 32),
		byte(ts >> 24), byte(ts >> 16), byte(ts >> 8), byte(ts),
	}
	token = append(token, tsBytes...)
	token = append(token, iv...)
	token = append(token, ciphertext...)

	mac := hmac.New(sha256.New, signingKey)
	mac.Write(token)
	token = append(token, mac.Sum(nil)...)

	// Test with raw token
	dec, err := Decrypt(token, keyStr)
	if err != nil {
		t.Fatalf("Decrypt raw fernet error: %v", err)
	}
	if string(dec) != string(msg) {
		t.Fatalf("got %q, want %q", string(dec), string(msg))
	}

	// Test with base64 url-encoded token (typical Python output)
	b64Token := base64.URLEncoding.EncodeToString(token)
	decB64, err := Decrypt([]byte(b64Token), keyStr)
	if err != nil {
		t.Fatalf("Decrypt b64 fernet error: %v", err)
	}
	if string(decB64) != string(msg) {
		t.Fatalf("got %q, want %q", string(decB64), string(msg))
	}
}
