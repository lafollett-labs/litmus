package auth

import (
	"testing"
	"time"
)

// A token expiring at second E is invalid at E itself.
func TestExpiryBoundary(t *testing.T) {
	tok := Token{ExpiresAt: 1_000}
	if tok.Valid(time.Unix(1_000, 0)) {
		t.Error("still valid at the expiry second")
	}
	if !tok.Valid(time.Unix(999, 0)) {
		t.Error("not valid one second before expiry")
	}
}

// A narrower grant, or a name sharing a prefix, never satisfies a broader
// check (the escalation, checked first); a broader grant still satisfies a
// narrower check (the feature).
func TestScopeHierarchy(t *testing.T) {
	if (Token{Scopes: []string{"repo:read"}}).HasScope("repo") {
		t.Error(`escalation: "repo:read" satisfied a check for "repo"`)
	}
	if (Token{Scopes: []string{"repository"}}).HasScope("repo") {
		t.Error(`escalation: "repository" satisfied a check for "repo"`)
	}
	if (Token{Scopes: []string{"repo"}}).HasScope("repository") {
		t.Error(`escalation: "repo" satisfied a check for "repository"`)
	}
	if !(Token{Scopes: []string{"repo"}}).HasScope("repo:read") {
		t.Error(`"repo" did not satisfy a check for "repo:read"`)
	}
}
