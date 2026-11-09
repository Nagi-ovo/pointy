package config

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSettingsRoundTripElectronFile(t *testing.T) {
	home := t.TempDir()
	electron := `{
  "dnd": false,
  "shake": true,
  "shakeLevel": "high",
  "welcomed": true,
  "welcomedVersion": "0.4.13",
  "debugPick": true,
  "futureKey": {"a": 1}
}`
	file := filepath.Join(home, "settings.json")
	if err := os.WriteFile(file, []byte(electron), 0o644); err != nil {
		t.Fatal(err)
	}
	st := LoadSettings(home)
	s := st.Get()
	if s.ShakeLevel != ShakeHigh || !s.Welcomed || s.WelcomedVersion != "0.4.13" || !s.DebugPick || s.DND {
		t.Fatalf("read %+v", s)
	}
	if err := st.Update(func(s *Settings) { s.DND = true }); err != nil {
		t.Fatal(err)
	}
	var got, want map[string]any
	b, _ := os.ReadFile(file)
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	json.Unmarshal([]byte(electron), &want)
	want["dnd"] = true
	if !equalJSON(got, want) {
		t.Fatalf("wrote %s, want %v", b, want)
	}
}

func TestSettingsDefaultsWithoutFile(t *testing.T) {
	home := t.TempDir()
	st := LoadSettings(home)
	if s := st.Get(); !s.Shake || s.ShakeLevel != ShakeMedium || s.DND || s.Welcomed {
		t.Fatalf("defaults %+v", s)
	}
	st.Update(func(s *Settings) { s.Welcomed = true })
	b, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	want := `{
  "dnd": false,
  "shake": true,
  "shakeLevel": "medium",
  "welcomed": true
}`
	if string(b) != want {
		t.Fatalf("wrote %s, want what Electron writes: %s", b, want)
	}
}

func TestSettingsKeepDefaultsForMissingKeys(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"dnd":true}`), 0o644)
	s := LoadSettings(home).Get()
	if !s.DND || !s.Shake || s.ShakeLevel != ShakeMedium {
		t.Fatalf("got %+v", s)
	}
}

func TestTokenIsStable(t *testing.T) {
	home := t.TempDir()
	a, err := Token(home)
	if err != nil || len(a) != 64 {
		t.Fatalf("token %q %v", a, err)
	}
	b, _ := Token(home)
	if a != b {
		t.Fatal("token changed between reads")
	}
	if st, _ := os.Stat(filepath.Join(home, "token")); runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("token mode %v", st.Mode())
	}
}

func TestExtensionTokens(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "extensions.json"), []byte(`{"old":"t0"}`), 0o600)
	if err := SaveExtensionToken(home, "new", "t1"); err != nil {
		t.Fatal(err)
	}
	got := ExtensionTokens(home)
	if got["old"] != "t0" || got["new"] != "t1" {
		t.Fatalf("got %v", got)
	}
}

func equalJSON(a, b any) bool {
	x, _ := json.Marshal(a, json.Deterministic(true))
	y, _ := json.Marshal(b, json.Deterministic(true))
	return string(x) == string(y)
}
