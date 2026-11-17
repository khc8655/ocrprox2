package netguard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"
)

func TestPublic(t *testing.T) {
	tests := []struct {
		ip     string
		public bool
	}{
		{"127.0.0.1", false},
		{"::1", false},
		{"::ffff:127.0.0.1", false},
		{"10.0.0.1", false},
		{"172.16.0.1", false},
		{"192.168.1.1", false},
		{"169.254.169.254", false}, // AWS metadata
		{"169.254.170.2", false},   // AWS ECS task metadata
		{"fe80::1", false},         // IPv6 link-local
		{"100.100.100.200", false}, // Alibaba metadata
		{"100.64.0.1", false},      // CGNAT
		{"198.18.0.1", false},      // Clash Fake-IP
		{"fc00::1", false},
		{"fd00:ec2::254", false}, // AWS IMDSv6
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"2606:4700:4700::1111", true},
	}

	for _, tc := range tests {
		addr := netip.MustParseAddr(tc.ip)
		if got := Public(addr); got != tc.public {
			t.Errorf("Public(%s) = %v, want %v", tc.ip, got, tc.public)
		}
	}
}

func TestPinnedDialContext_DirectIPBlocked(t *testing.T) {
	dialer := NewPinnedDialContext(time.Second, false)
	ctx := context.Background()

	_, err := dialer(ctx, "tcp", "127.0.0.1:80")
	if err == nil {
		t.Errorf("expected error connecting to 127.0.0.1, got nil")
	}

	_, err = dialer(ctx, "tcp", "169.254.169.254:80")
	if err == nil {
		t.Errorf("expected error connecting to metadata IP, got nil")
	}
}

func TestPinnedDialContext_LinkLocalBlockedEvenWhenAllowPrivate(t *testing.T) {
	dialer := NewPinnedDialContext(time.Second, true)
	ctx := context.Background()

	for _, target := range []string{
		"169.254.169.254:80",
		"169.254.170.2:80",
		"169.254.0.1:80",
		"[::ffff:169.254.170.2]:80",
		"[fe80::1]:80",
		"[fd00:ec2::254]:80",
		"100.100.100.200:80",
	} {
		_, err := dialer(ctx, "tcp", target)
		if !errors.Is(err, ErrBlockedAddress) {
			t.Errorf("expected ErrBlockedAddress for %s with allowPrivate=true, got %v", target, err)
		}
	}

	// Verify RFC1918 and ULA pass isAlwaysBlocked (not blocked by SSRF guard when allowPrivate=true)
	for _, priv := range []string{"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "fc00::1", "fd12:3456::1"} {
		if isAlwaysBlocked(netip.MustParseAddr(priv)) {
			t.Errorf("expected %s not to be unconditionally blocked when allowPrivate=true", priv)
		}
	}
}

func TestPinnedDialContext_LoopbackAllowed(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen on loopback: %v", err)
	}
	defer l.Close()

	dialer := NewPinnedDialContext(time.Second, true)
	ctx := context.Background()

	conn, err := dialer(ctx, "tcp", l.Addr().String())
	if err != nil {
		t.Fatalf("expected success with allowPrivate=true, got %v", err)
	}
	conn.Close()
}

type trackingConn struct {
	net.Conn
	closed atomic.Bool
}

func (c *trackingConn) Close() error {
	c.closed.Store(true)
	return c.Conn.Close()
}

func TestHappyEyeballs_DrainsLateIPv6ConnWhenIPv4Wins(t *testing.T) {
	v6Client, v6Server := net.Pipe()
	defer v6Server.Close()
	v4Client, v4Server := net.Pipe()
	defer v4Server.Close()

	trackedV6 := &trackingConn{Conn: v6Client}
	trackedV4 := &trackingConn{Conn: v4Client}

	v6Ready := make(chan struct{})
	dialFn := func(ctx context.Context, network, address string) (net.Conn, error) {
		host, _, _ := net.SplitHostPort(address)
		ip := netip.MustParseAddr(host)
		if ip.Is6() {
			// Wait until headStart expires, then simulate succeeding right before observing cancel
			<-ctx.Done()
			close(v6Ready)
			return trackedV6, nil
		}
		<-v6Ready
		return trackedV4, nil
	}

	winner, ok := happyEyeballsDial(
		context.Background(),
		dialFn,
		netip.MustParseAddr("2606:4700:4700::1111"),
		[]netip.Addr{netip.MustParseAddr("1.1.1.1")},
		"443",
		15*time.Millisecond,
	)
	if !ok || winner != trackedV4 {
		t.Fatalf("expected IPv4 connection to win, ok=%v", ok)
	}
	defer winner.Close()

	// Wait briefly for cleanup goroutine to drain resCh and close late IPv6 socket
	deadline := time.Now().Add(500 * time.Millisecond)
	for !trackedV6.closed.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !trackedV6.closed.Load() {
		t.Fatalf("expected late-arriving IPv6 connection to be closed cleanly, but it leaked")
	}
	if trackedV4.closed.Load() {
		t.Fatalf("expected winning IPv4 connection to remain open")
	}
}
