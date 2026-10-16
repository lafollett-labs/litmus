package auth

import "testing"

func TestSignVerify(t *testing.T) {
	key := []byte("k")
	tok := Token{Subject: "ada", Scopes: []string{"repo"}, ExpiresAt: 2_000_000_000}
	tok.Signature = Sign(tok, key)
	if !Verify(tok, key) {
		t.Fatal("a token did not verify under its own key")
	}
	tok.Scopes = []string{"admin"}
	if Verify(tok, key) {
		t.Fatal("a token with altered scopes still verified")
	}
}
