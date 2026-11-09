package main

import (
	"github.com/pointylab/pointy/desktop/internal/desktop"
	win "github.com/pointylab/pointy/desktop/internal/desktop/windows"
)

func newDesktop(string) desktop.Desktop { return win.New() }
