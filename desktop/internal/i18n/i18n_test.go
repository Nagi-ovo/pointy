package i18n

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
)

func TestEveryKeyNamesAMessageInEveryLanguage(t *testing.T) {
	for _, lang := range Languages {
		for _, k := range declared {
			_, plain := catalogs[lang][k.id]
			_, plural := catalogs[lang][k.id+"_other"]
			if !plain && !plural {
				t.Errorf("locales/%s.json has no %s", lang, k.id)
			}
		}
	}
}

func TestMessagesFillPlaceholdersAndPluralForms(t *testing.T) {
	cases := []struct{ lang, got, want string }{
		{"zh-CN", In("zh-CN", TrayApprovals, "count", 1), "1 个操作等你批准"},
		{"zh-CN", In("zh-CN", TrayApprovals, "count", 3), "3 个操作等你批准"},
		{"en", In("en", TrayApprovals, "count", 1), "1 action needs your approval"},
		{"en", In("en", TrayApprovals, "count", 3), "3 actions need your approval"},
		{"zh-CN", In("zh-CN", TrayAgentOffline, "agent", "DSH"), "DSH 未连接"},
		{"en", In("en", PairTitle, "browser", "Edge"), "The Pointy extension in Edge wants to connect"},
		{"en", In("en", PairTitle), "The Pointy extension in {browser} wants to connect"},
		{"en", In("en", Control("ControlType.Button")), "Button"},
		{"zh-CN", In("zh-CN", Control("ControlType.Spinner")), "控件"},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: %q, want %q", c.lang, c.got, c.want)
		}
	}
}

func TestPagesGetTheKeyAndParams(t *testing.T) {
	m := Msg(PairTitle, "browser", "Chrome")
	if m.Key != "pair.title" || m.Params["browser"] != "Chrome" {
		t.Fatalf("%+v", m)
	}
	if m := Msg(PairBody); m.Params != nil {
		t.Fatalf("params without placeholders: %+v", m)
	}
}

func TestLanguageFollowsTheSystemUnlessChosen(t *testing.T) {
	cases := []struct {
		override  string
		preferred []string
		want      string
	}{
		{"", []string{"zh-Hans-CN", "en-GB"}, "zh-CN"},
		{"", []string{"en-GB", "zh-Hans-CN"}, "en"},
		{"", []string{"fr-FR"}, "zh-CN"},
		{"", nil, "zh-CN"},
		{"en", []string{"zh-Hans-CN"}, "en"},
		{"zh-CN", []string{"en-US"}, "zh-CN"},
	}
	for _, c := range cases {
		if got := Resolve(c.override, c.preferred); got != c.want {
			t.Errorf("Resolve(%q, %v) = %q, want %q", c.override, c.preferred, got, c.want)
		}
	}
}

// Go code says its texts through the catalogs; Chinese in a string
// literal is a text that skipped them. Patterns that match Chinese window
// titles are listed here.
var matchesChinese = map[string]bool{"internal/desktop/block.go": true}

func TestGoCodeHasNoChineseLiterals(t *testing.T) {
	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if matchesChinese[filepath.ToSlash(rel)] {
			return nil
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING && strings.ContainsFunc(lit.Value, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
				t.Errorf("%s: %s belongs in locales/", fset.Position(lit.Pos()), lit.Value)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
