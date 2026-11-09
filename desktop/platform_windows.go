package main

import (
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/desktop/windows"
)

func newDesktop() desktop.Desktop { return windows.New() }
