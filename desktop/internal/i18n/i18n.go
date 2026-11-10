// Package i18n says Pointy's Go-drawn texts in the language the user reads,
// from the catalogs in locales/, which the pages share. Texts a page shows
// cross as a contract.Message, a key and its params, for the page to word.
package i18n

import (
	"encoding/json/v2"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"

	mi18n "github.com/egoist/mygo/i18n"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/locales"
)

// Languages are the catalogs' languages; the first is Pointy's own, which
// a reader of none of them gets and which fills in missing messages.
var Languages = []string{"zh-CN", "en"}

// Key names a message of the catalogs. Only this package makes keys, so a
// key that names no message cannot be written elsewhere.
type Key struct{ id string }

func (k Key) String() string { return k.id }

var declared []Key

func key(id string) Key {
	k := Key{id}
	declared = append(declared, k)
	return k
}

// catalogs maps a language to its messages, flattened to dotted keys.
var catalogs = load()

func load() map[string]map[string]string {
	out := map[string]map[string]string{}
	for _, lang := range Languages {
		b, err := locales.FS.ReadFile(lang + ".json")
		if err != nil {
			panic(err)
		}
		var tree map[string]any
		if err := json.Unmarshal(b, &tree); err != nil {
			panic(fmt.Errorf("locales/%s.json: %w", lang, err))
		}
		flat := map[string]string{}
		flatten("", tree, flat)
		out[lang] = flat
	}
	return out
}

func flatten(prefix string, tree map[string]any, out map[string]string) {
	for k, v := range tree {
		switch v := v.(type) {
		case string:
			out[prefix+k] = v
		case map[string]any:
			flatten(prefix+k+".", v, out)
		}
	}
}

var current atomic.Value

func init() { current.Store(Languages[0]) }

// Locale is the language Pointy shows.
func Locale() string { return current.Load().(string) }

// Use makes Pointy show lang, one of Languages.
func Use(lang string) { current.Store(lang) }

// Resolve is the language to show a reader of preferred, or of override
// when the user chose one: the best match of Languages, else Pointy's own.
func Resolve(override string, preferred []string) string {
	want := preferred
	if override != "" {
		want = append([]string{override}, preferred...)
	}
	if m := mi18n.Match(want, Languages); m != "" {
		return m
	}
	return Languages[0]
}

// T says k in the language Pointy shows. args are name, value pairs for
// the message's {name} placeholders; a count picks the plural form.
func T(k Key, args ...any) string { return In(Locale(), k, args...) }

// In says k in lang.
func In(lang string, k Key, args ...any) string {
	params := map[string]string{}
	var count any
	for i := 0; i+1 < len(args); i += 2 {
		name := fmt.Sprint(args[i])
		params[name] = fmt.Sprint(args[i+1])
		if name == "count" {
			count = args[i+1]
		}
	}
	msg, ok := lookup(lang, k.id, count)
	if !ok {
		msg, ok = lookup(Languages[0], k.id, count)
	}
	if !ok {
		return k.id
	}
	return fill(msg, params)
}

func lookup(lang, id string, count any) (string, bool) {
	cat := catalogs[lang]
	if count != nil {
		if ops, err := mi18n.NewOperands(count); err == nil {
			if m, ok := cat[id+"_"+mi18n.PluralCategory(lang, ops).String()]; ok {
				return m, true
			}
		}
		if m, ok := cat[id+"_other"]; ok {
			return m, true
		}
	}
	m, ok := cat[id]
	return m, ok
}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

func fill(msg string, params map[string]string) string {
	return placeholder.ReplaceAllStringFunc(msg, func(m string) string {
		if v, ok := params[m[1:len(m)-1]]; ok {
			return v
		}
		return m
	})
}

// Msg is k with its params for a page to word.
func Msg(k Key, args ...string) contract.Message {
	m := contract.Message{Key: k.id}
	for i := 0; i+1 < len(args); i += 2 {
		if m.Params == nil {
			m.Params = map[string]string{}
		}
		m.Params[args[i]] = args[i+1]
	}
	return m
}

var blockHints = map[contract.BlockReason]Key{
	contract.BlockPasswordField: HintBlockedPassword,
	contract.BlockLoginWindow:   HintBlockedLogin,
	contract.BlockApp:           HintBlockedApp,
}

// BlockHint is the hint that tells the user why Pointy kept out; ok is
// false for a reason it has no hint for.
func BlockHint(r contract.BlockReason) (hint string, ok bool) {
	k, ok := blockHints[r]
	if !ok {
		return "", false
	}
	return T(k), true
}

// Control is the message naming a UI Automation control type, as
// "ControlType.Button".
func Control(controlType string) Key {
	id := "control." + strings.TrimPrefix(controlType, "ControlType.")
	if _, ok := catalogs[Languages[0]][id]; ok {
		return Key{id}
	}
	return ControlCustom
}
