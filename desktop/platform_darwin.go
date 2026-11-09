package main

import (
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/desktop/darwin"
)

func newDesktop() desktop.Desktop { return darwin.New() }
