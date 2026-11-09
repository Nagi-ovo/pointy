// Package config holds Pointy's files in POINTY_HOME (~/.pointy), in the
// same shapes the Electron runtime wrote, so a home from either runtime
// works with the other.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	DefaultPort = 47321
	errorLogMax = 256 * 1024
)

// Port is where the server listens, POINTY_PORT or 47321.
func Port() int {
	if p, err := strconv.Atoi(os.Getenv("POINTY_PORT")); err == nil && p > 0 {
		return p
	}
	return DefaultPort
}

// Home is POINTY_HOME, or ~/.pointy.
func Home() string {
	if h := os.Getenv("POINTY_HOME"); h != "" {
		return h
	}
	dir, err := os.UserHomeDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, ".pointy")
}

// Managed reports whether DSH started Pointy and owns its lifetime.
func Managed() bool { return os.Getenv("POINTY_MANAGED") == "1" }

var logMu sync.Mutex

// LogError appends a line to error.log in home, which it starts over past
// 256 KiB.
func LogError(home, kind string, err any) {
	logMu.Lock()
	defer logMu.Unlock()
	if os.MkdirAll(home, 0o755) != nil {
		return
	}
	file := filepath.Join(home, "error.log")
	if st, e := os.Stat(file); e == nil && st.Size() > errorLogMax {
		os.Remove(file)
	}
	f, e := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if e != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s [%s] %v\n", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), kind, err)
}

// Token returns the secret the plugin proves it knows, creating it on first
// use.
func Token(home string) (string, error) {
	file := filepath.Join(home, "token")
	if b, err := os.ReadFile(file); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			return t, nil
		}
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		return "", err
	}
	token := RandomHex(32)
	return token, os.WriteFile(file, []byte(token), 0o600)
}

func RandomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ExtensionTokens reads extensions.json, the token of every paired browser
// extension by its id.
func ExtensionTokens(home string) map[string]string {
	tokens := map[string]string{}
	if b, err := os.ReadFile(filepath.Join(home, "extensions.json")); err == nil {
		json.Unmarshal(b, &tokens)
	}
	return tokens
}

// SaveExtensionToken adds a paired extension to extensions.json.
func SaveExtensionToken(home, id, token string) error {
	tokens := ExtensionTokens(home)
	tokens[id] = token
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	b, err := json.Marshal(tokens, json.Deterministic(true), jsontext.WithIndent("  "))
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(home, "extensions.json"), b, 0o600)
}
