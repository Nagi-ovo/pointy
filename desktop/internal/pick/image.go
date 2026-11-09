package pick

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/draw"
	"image/jpeg"
)

const (
	maxImageWidth = 1600
	jpegQuality   = 85
)

// jpegDataURL encodes a capture for the card, no wider than maxImageWidth.
func jpegDataURL(src image.Image) (string, error) {
	var img image.Image = src
	if src.Bounds().Dx() > maxImageWidth {
		rgba, ok := src.(*image.RGBA)
		if !ok {
			rgba = image.NewRGBA(image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy()))
			draw.Draw(rgba, rgba.Bounds(), src, src.Bounds().Min, draw.Src)
		}
		img = shrink(rgba, maxImageWidth)
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", err
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(b.Bytes()), nil
}

// shrink scales src down to width w, averaging the pixels each one covers.
func shrink(src *image.RGBA, w int) *image.RGBA {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	h := max(1, sh*w/sw)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		y0, y1 := y*sh/h, max(y*sh/h+1, (y+1)*sh/h)
		for x := range w {
			x0, x1 := x*sw/w, max(x*sw/w+1, (x+1)*sw/w)
			var sum [4]int
			for sy := y0; sy < y1; sy++ {
				row := src.Pix[(sy)*src.Stride:]
				for sx := x0; sx < x1; sx++ {
					for c := range 4 {
						sum[c] += int(row[sx*4+c])
					}
				}
			}
			n := (y1 - y0) * (x1 - x0)
			o := dst.Pix[y*dst.Stride+x*4:]
			for c := range 4 {
				o[c] = uint8(sum[c] / n)
			}
		}
	}
	return dst
}
