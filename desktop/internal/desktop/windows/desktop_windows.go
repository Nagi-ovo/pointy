//go:build windows

// Package windows implements desktop.Desktop on Windows, where screen units
// are physical pixels. Until the Windows port lands, every method answers
// errors.ErrUnsupported.
package windows

import "github.com/pointylab/pointy/desktop/internal/desktop"

type Desktop struct {
	desktop.Unsupported
}

func New() *Desktop { return &Desktop{} }
