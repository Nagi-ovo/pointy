//go:build !darwin && !windows

package main

import "github.com/pointylab/pointy/desktop/internal/desktop"

func newDesktop(string) desktop.Desktop { return desktop.Unsupported{} }
