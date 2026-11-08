package netguard

import (
	"context"
	"net"
	"net/netip"
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
		{"100.100.100.200", false}, // Alibaba metadata
		{"100.64.0.1", false},      // CGNAT
		{"198.18.0.1", false},      // Clash Fake-IP
		{"fc00::1", false},
		{"fd00:ec2::254", false},   // AWS IMDSv6
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
