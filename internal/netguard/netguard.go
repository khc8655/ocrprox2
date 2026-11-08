// Package netguard provides SSRF protection, IP range checking, and DNS Pinning with Happy Eyeballs.
// Portions adapted from yetone/magpie (MIT License).
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"syscall"
	"time"
)

var (
	ErrBlockedAddress = errors.New("netguard: address is blocked by SSRF protection")
	ErrNoValidIP      = errors.New("netguard: no valid public IP found for host")
)

var (
	metaAWSv4 = netip.MustParseAddr("169.254.169.254")
	metaAWSv6 = netip.MustParseAddr("fd00:ec2::254")
	metaAli   = netip.MustParseAddr("100.100.100.200")
)

var specialNets = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8",       // "this" network
		"100.64.0.0/10",   // CGNAT, Tailscale, Ali metadata
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // documentation
		"198.18.0.0/15",   // benchmarking / Fake-IP
		"198.51.100.0/24", // documentation
		"203.0.113.0/24",  // documentation
		"240.0.0.0/4",     // reserved, broadcast
		"::/96",           // IPv4-compatible (deprecated)
		"100::/64",        // discard
		"2001::/32",       // Teredo
		"2001:db8::/32",   // documentation
		"fec0::/10",       // site-local (deprecated)
		"64:ff9b:1::/48",  // local-use NAT64
		"fc00::/7",        // unique local IPv6
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// IsMetadataIP returns true for known cloud metadata service IPs.
func IsMetadataIP(a netip.Addr) bool {
	a = a.Unmap()
	return a == metaAWSv4 || a == metaAWSv6 || a == metaAli
}

// Public checks if the IP address is on the public open internet.
// Blocks loopback, private RFC 1918, fc00::/7, link-local, CGNAT (100.64.0.0/10),
// Clash Fake-IP (198.18.0.0/15), and cloud metadata.
func Public(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsUnspecified() ||
		a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsInterfaceLocalMulticast() || a.IsMulticast() {
		return false
	}
	if IsMetadataIP(a) {
		return false
	}
	for _, n := range specialNets {
		if n.Contains(a) {
			return false
		}
	}
	return true
}

// PinnedDialer dial function type
type DialContextFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// NewPinnedDialContext returns a dialer function that performs:
// 1. DNS resolution and SSRF address validation.
// 2. DNS Pinning (dials the resolved IP directly to prevent DNS rebinding).
// 3. Happy Eyeballs: when both IPv6 and IPv4 exist, tries IPv6 with 300ms timeout before falling back to IPv4.
func NewPinnedDialContext(timeout time.Duration, allowPrivate bool) DialContextFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, fmt.Errorf("netguard: split host port error: %w", err)
		}

		// Check if host is direct IP
		if ip, err := netip.ParseAddr(host); err == nil {
			ip = ip.Unmap()
			if IsMetadataIP(ip) {
				return nil, ErrBlockedAddress
			}
			if !allowPrivate && !Public(ip) {
				return nil, ErrBlockedAddress
			}
			dialer := &net.Dialer{Timeout: timeout}
			return dialer.DialContext(ctx, network, addr)
		}

		// DNS lookup
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, fmt.Errorf("netguard: dns lookup %s: %w", host, err)
		}

		var v4List []netip.Addr
		var v6List []netip.Addr

		for _, ip := range ips {
			addr, ok := netip.AddrFromSlice(ip)
			if !ok {
				continue
			}
			addr = addr.Unmap()
			if IsMetadataIP(addr) {
				return nil, ErrBlockedAddress
			}
			if !allowPrivate && !Public(addr) {
				continue
			}
			if addr.Is4() {
				v4List = append(v4List, addr)
			} else if addr.Is6() {
				v6List = append(v6List, addr)
			}
		}

		if len(v4List) == 0 && len(v6List) == 0 {
			return nil, ErrNoValidIP
		}

		dialer := &net.Dialer{
			Timeout: timeout,
			Control: func(network, address string, c syscall.RawConn) error {
				h, _, e := net.SplitHostPort(address)
				if e == nil {
					if parsed, pe := netip.ParseAddr(h); pe == nil {
						if IsMetadataIP(parsed.Unmap()) {
							return ErrBlockedAddress
						}
						if !allowPrivate && !Public(parsed.Unmap()) {
							return ErrBlockedAddress
						}
					}
				}
				return nil
			},
		}

		// Happy Eyeballs fallback logic
		// If both IPv6 and IPv4 exist:
		if len(v6List) > 0 && len(v4List) > 0 {
			type dialRes struct {
				conn net.Conn
				err  error
			}
			resCh := make(chan dialRes, 1)
			v6Ctx, v6Cancel := context.WithTimeout(ctx, 300*time.Millisecond)
			defer v6Cancel()

			var wg sync.WaitGroup
			wg.Add(1)
			go func() {
				defer wg.Done()
				target := net.JoinHostPort(v6List[0].String(), port)
				conn, dialErr := dialer.DialContext(v6Ctx, "tcp", target)
				if dialErr == nil {
					resCh <- dialRes{conn: conn}
				}
			}()

			select {
			case res := <-resCh:
				return res.conn, nil
			case <-v6Ctx.Done():
				// IPv6 timed out or context expired: fall back to IPv4
			}

			// Try IPv4 candidates in order
			for _, v4 := range v4List {
				target := net.JoinHostPort(v4.String(), port)
				conn, err := dialer.DialContext(ctx, "tcp", target)
				if err == nil {
					return conn, nil
				}
			}

			// If IPv4 all failed, wait for IPv6 goroutine if parent context still alive
			wg.Wait()
			select {
			case res := <-resCh:
				return res.conn, res.err
			default:
			}
		}

		// Try v6 candidates first if available
		for _, v6 := range v6List {
			target := net.JoinHostPort(v6.String(), port)
			conn, err := dialer.DialContext(ctx, "tcp", target)
			if err == nil {
				return conn, nil
			}
		}

		// Try v4 candidates
		for _, v4 := range v4List {
			target := net.JoinHostPort(v4.String(), port)
			conn, err := dialer.DialContext(ctx, "tcp", target)
			if err == nil {
				return conn, nil
			}
		}

		return nil, fmt.Errorf("netguard: failed to connect to any resolved IP for %s", host)
	}
}
