package ui

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestPlaceCardBesideCursorInsideWorkArea(t *testing.T) {
	wa := mygo.Rectangle{X: 0, Y: 25, Width: 1440, Height: 875}
	cases := []struct {
		name   string
		cursor mygo.Point
		want   mygo.Rectangle
	}{
		{"middle", mygo.Point{X: 400, Y: 300}, mygo.Rectangle{X: 412, Y: 316, Width: cardW, Height: cardHAsk}},
		{"right edge", mygo.Point{X: 1400, Y: 300}, mygo.Rectangle{X: 1440 - cardW, Y: 316, Width: cardW, Height: cardHAsk}},
		{"bottom edge", mygo.Point{X: 400, Y: 880}, mygo.Rectangle{X: 412, Y: 900 - cardHAsk, Width: cardW, Height: cardHAsk}},
		{"under menu bar", mygo.Point{X: 400, Y: 0}, mygo.Rectangle{X: 412, Y: 25, Width: cardW, Height: cardHAsk}},
		{"left of work area", mygo.Point{X: -500, Y: 300}, mygo.Rectangle{X: 0, Y: 316, Width: cardW, Height: cardHAsk}},
	}
	for _, c := range cases {
		if got := placeCard(c.cursor, wa, cardW, cardHAsk); got != c.want {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
}
