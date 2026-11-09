package config

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"sync"
)

type ShakeLevel string

const (
	ShakeLow    ShakeLevel = "low"
	ShakeMedium ShakeLevel = "medium"
	ShakeHigh   ShakeLevel = "high"
)

// Settings is settings.json. Keys this runtime does not know are kept.
type Settings struct {
	DND             bool           `json:"dnd"`
	Shake           bool           `json:"shake"`
	ShakeLevel      ShakeLevel     `json:"shakeLevel"`
	Welcomed        bool           `json:"welcomed"`
	WelcomedVersion string         `json:"welcomedVersion,omitempty"`
	DebugPick       bool           `json:"debugPick,omitzero"`
	Unknown         jsontext.Value `json:",embed"`
}

var defaults = Settings{Shake: true, ShakeLevel: ShakeMedium}

// Store is settings.json in a home, safe for concurrent use.
type Store struct {
	mu   sync.Mutex
	file string
	s    Settings
}

// LoadSettings reads settings.json, falling back to the defaults for a
// missing or broken file.
func LoadSettings(home string) *Store {
	st := &Store{file: filepath.Join(home, "settings.json"), s: defaults}
	if b, err := os.ReadFile(st.file); err == nil {
		s := defaults
		if json.Unmarshal(b, &s) == nil {
			st.s = s
		}
	}
	return st
}

func (st *Store) Get() Settings {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s
}

// Update changes the settings and writes them.
func (st *Store) Update(change func(*Settings)) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	change(&st.s)
	b, err := json.Marshal(st.s, jsontext.WithIndent("  "))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(st.file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(st.file, b, 0o644)
}
