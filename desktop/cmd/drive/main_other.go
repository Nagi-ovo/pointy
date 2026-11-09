//go:build !darwin

// Command drive posts real mouse input for tests of pointing; it runs on
// macOS only for now.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "drive: macOS only")
	os.Exit(1)
}
