package browser

import (
	"testing"

	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/server"
)

func sendSelection(raw string) *contract.Grab {
	var got *contract.Grab
	e := New(Deps{OnSelection: func(g contract.Grab) { got = &g }})
	(&handler{e: e}).OnMessage(server.Message{Type: "selection", Raw: []byte(raw)})
	return got
}

func TestSelectionOpensACardOnTheText(t *testing.T) {
	g := sendSelection(`{"type":"selection","browser":"chrome","url":"https://example.com/","pageTitle":"Example","text":"a paragraph"}`)
	if g == nil {
		t.Fatal("no card opened")
	}
	if g.Text != "a paragraph" || g.Source != (contract.GrabSource{App: "chrome", Title: "Example"}) || g.Method != contract.MethodExtension {
		t.Fatalf("grab %+v", g)
	}
}

func TestSelectionFromAPasswordFieldOpensNothing(t *testing.T) {
	if g := sendSelection(`{"type":"selection","browser":"chrome","url":"https://example.com/","pageTitle":"Example","blocked":"password-field"}`); g != nil {
		t.Fatalf("opened a card on %+v", g)
	}
}

func TestSelectionOnALoginPageOpensNothing(t *testing.T) {
	for _, title := range []string{"Sign in - Google Accounts", "登录 - 网上银行"} {
		if g := sendSelection(`{"type":"selection","browser":"chrome","pageTitle":"` + title + `","text":"user@example.com"}`); g != nil {
			t.Errorf("%s: opened a card on %+v", title, g)
		}
	}
}
