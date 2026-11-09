// Package contract holds the data that crosses between Go and the pages.
// `go tool mygo generate` writes their TypeScript twins into
// app/bridge/mygo.ts, which app/types.d.ts aliases.
package contract

// GrabSource is the app and window a grab came from.
type GrabSource struct {
	App   string `json:"app"`
	Title string `json:"title"`
}

type GrabLink struct {
	Text string `json:"text"`
	Href string `json:"href"`
}

type GrabImage struct {
	Alt string `json:"alt"`
	Src string `json:"src"`
}

// GrabElement is the element a pick landed on.
type GrabElement struct {
	Kind   string            `json:"kind"`
	Site   string            `json:"site,omitempty"`
	Tag    string            `json:"tag,omitempty"`
	Text   string            `json:"text,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
	Page   map[string]string `json:"page,omitempty"`
	Links  []GrabLink        `json:"links,omitempty"`
	Images []GrabImage       `json:"images,omitempty"`
}

// GrabMethod is how a grab was read.
type GrabMethod string

const (
	MethodPick      GrabMethod = "pick"
	MethodUIAPick   GrabMethod = "uia-pick"
	MethodExtension GrabMethod = "extension"
	MethodUIA       GrabMethod = "uia"
	MethodClipboard GrabMethod = "clipboard"
	MethodNone      GrabMethod = "none"
)

// ShotKind says what a grab's screenshot shows.
type ShotKind string

const (
	ShotFocus   ShotKind = "focus"
	ShotElement ShotKind = "element"
)

// GrabNote is a line the card shows above the grab.
type GrabNote struct {
	Text    string `json:"text"`
	Install bool   `json:"install"`
}

// Grab is what the user pointed at, which a card asks about.
type Grab struct {
	Source    GrabSource   `json:"source"`
	Method    GrabMethod   `json:"method"`
	Text      string       `json:"text,omitempty"`
	URL       string       `json:"url,omitempty"`
	PageTitle string       `json:"pageTitle,omitempty"`
	Element   *GrabElement `json:"element,omitempty"`
	Image     string       `json:"image,omitempty"`
	WideImage string       `json:"wideImage,omitempty"`
	ShotKind  ShotKind     `json:"shotKind,omitempty"`
	Before    string       `json:"before,omitempty"`
	After     string       `json:"after,omitempty"`
	Note      *GrabNote    `json:"note,omitempty"`
	Blocked   string       `json:"blocked,omitempty"`
}

// AgentInfo names the agent a card asks.
type AgentInfo struct {
	Name string `json:"name"`
}

// CardInit opens a card: a pairing code when Mode is "pair", else a grab
// to ask about.
type CardInit struct {
	Mode  string     `json:"mode,omitempty"`
	Code  string     `json:"code,omitempty"`
	Grab  *Grab      `json:"grab,omitempty"`
	Agent *AgentInfo `json:"agent,omitempty"`
}

// PillState is how a kept card's task is going.
type PillState string

const (
	PillRun   PillState = "run"
	PillDone  PillState = "done"
	PillError PillState = "error"
)

// KeepInfo is a card closing while its task runs on, as a pill.
type KeepInfo struct {
	SessionID  string    `json:"sessionId,omitempty"`
	Title      string    `json:"title"`
	State      PillState `json:"state"`
	FixedTitle bool      `json:"fixedTitle"`
}

// PillItem is one pill.
type PillItem struct {
	ID    string    `json:"id"`
	Title string    `json:"title"`
	State PillState `json:"state"`
}

type NoticeButton struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Primary bool   `json:"primary,omitempty"`
}

// NoticeParagraph is a paragraph, with values to copy under it when Copy
// is set.
type NoticeParagraph struct {
	Text string   `json:"text"`
	Copy []string `json:"copy,omitempty"`
}

type NoticeInit struct {
	Title   string            `json:"title"`
	Body    []NoticeParagraph `json:"body"`
	Buttons []NoticeButton    `json:"buttons,omitempty"`
}

type IntroInit struct {
	Version string `json:"version"`
}

// LocalRect is a rectangle in a window's coordinates.
type LocalRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// OverlayHighlight is the box the pointing overlay draws.
type OverlayHighlight struct {
	LocalRect
	Label string     `json:"label"`
	Focus *LocalRect `json:"focus"`
}

// Shift moves the overlay's drawing as the window under it moves.
type Shift struct {
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
}
