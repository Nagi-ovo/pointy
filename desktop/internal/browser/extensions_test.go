package browser

import (
	"testing"

	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/i18n"
	"github.com/pointylab/pointy/desktop/internal/server"
)

func sendSelection(raw string) (*contract.Grab, []string) {
	var got *contract.Grab
	var hints []string
	e := New(Deps{OnSelection: func(g contract.Grab) { got = &g }, ShowHint: func(h string) { hints = append(hints, h) }})
	(&handler{e: e}).OnMessage(server.Message{Type: "selection", Raw: []byte(raw)})
	return got, hints
}

func TestSelectionOpensACardOnTheText(t *testing.T) {
	g, hints := sendSelection(`{"type":"selection","browser":"chrome","url":"https://example.com/","pageTitle":"Example","text":"a paragraph"}`)
	if len(hints) > 0 {
		t.Errorf("hinted %q on an allowed selection", hints)
	}
	if g == nil {
		t.Fatal("no card opened")
	}
	if g.Text != "a paragraph" || g.Source != (contract.GrabSource{App: "chrome", Title: "Example"}) || g.Method != contract.MethodExtension {
		t.Fatalf("grab %+v", g)
	}
}

func TestSelectionFromAPasswordFieldOpensNothingAndSaysWhy(t *testing.T) {
	g, hints := sendSelection(`{"type":"selection","browser":"chrome","url":"https://example.com/","pageTitle":"Example","blocked":"password-field"}`)
	if g != nil {
		t.Fatalf("opened a card on %+v", g)
	}
	if want, _ := i18n.BlockHint(contract.BlockPasswordField); len(hints) != 1 || hints[0] != want {
		t.Fatalf("hints %q, want [%q]", hints, want)
	}
}

func TestSelectionOnALoginPageOpensNothing(t *testing.T) {
	for _, title := range []string{"Sign in - Google Accounts", "登录 - 网上银行"} {
		g, hints := sendSelection(`{"type":"selection","browser":"chrome","pageTitle":"` + title + `","text":"user@example.com"}`)
		if g != nil {
			t.Errorf("%s: opened a card on %+v", title, g)
		}
		if want, _ := i18n.BlockHint(contract.BlockLoginWindow); len(hints) != 1 || hints[0] != want {
			t.Errorf("%s: hints %q, want [%q]", title, hints, want)
		}
	}
}
