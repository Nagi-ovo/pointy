// Package locales embeds the message catalogs that the pages and the Go
// runtime share, one i18next JSON v4 file per language.
package locales

import "embed"

//go:embed *.json
var FS embed.FS
