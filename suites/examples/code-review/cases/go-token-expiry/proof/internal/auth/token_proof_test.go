package auth

import (
	"testing"
	"time"
)

// A token expiring at second E is invalid at E itself.
func TestExpiryBoundary(t *testing.T) {
	tok := Token{ExpiresAt: 1_000}
	if !tok.Valid(time.Unix(999, 0)) {
		t.Fatal("not valid one second before expiry")
	}
	if tok.Valid(time.Unix(1_000, 0)) {
		t.Fatal("still valid at the expiry second")
	}
}

// A broader grant satisfies a narrower check; a narrower grant, or a longer
// name sharing a prefix, never satisfies a broader one.
func TestScopeHierarchy(t *testing.T) {
	if !(Token{Scopes: []string{"repo"}}).HasScope("repo:read") {
		t.Fatal(`"repo" did not satisfy a check for "repo:read"`)
	}
	if (Token{Scopes: []string{"repo:read"}}).HasScope("repo") {
		t.Fatal(`"repo:read" satisfied a check for "repo"`)
	}
	if (Token{Scopes: []string{"repository"}}).HasScope("repo") {
		t.Fatal(`"repository" satisfied a check for "repo"`)
	}
}
