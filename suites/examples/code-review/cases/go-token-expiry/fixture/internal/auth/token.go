// Package auth issues and checks signed session tokens.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// Token is a session token: who it is for, what it grants, and when it lapses.
type Token struct {
	Subject   string
	Scopes    []string
	ExpiresAt int64 // Unix seconds; the token is invalid from this second on
	Signature string
}

// Valid reports whether the token is still live at now.
func (t Token) Valid(now time.Time) bool {
	return now.Unix() < t.ExpiresAt
}

// HasScope reports whether the token grants exactly the scope want.
func (t Token) HasScope(want string) bool {
	for _, s := range t.Scopes {
		if s == want {
			return true
		}
	}
	return false
}

// Sign computes the token's signature over its subject, scopes and expiry.
func Sign(t Token, key []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(t.Subject + "|" + strings.Join(t.Scopes, ",") + "|" + strconv.FormatInt(t.ExpiresAt, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

// Verify checks the token's signature in constant time.
func Verify(t Token, key []byte) bool {
	want := Sign(t, key)
	return subtle.ConstantTimeCompare([]byte(want), []byte(t.Signature)) == 1
}
