module github.com/pointylab/pointy/desktop

go 1.27.3

tool github.com/egoist/mygo/cmd/mygo

require (
	github.com/coder/websocket v1.8.15
	github.com/ebitengine/purego v0.11.1
	github.com/egoist/mygo v0.8.3
	github.com/go-ole/go-ole v1.3.0
	github.com/pointylab/pointy/locales v0.0.0
	golang.org/x/sys v0.50.0
)

require (
	golang.org/x/net v0.59.0 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/pointylab/pointy/locales => ../locales
