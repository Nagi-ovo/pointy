package pick

// countReversals counts how often xs turns back after travelling at least
// amplitude from the farthest point it reached.
func countReversals(xs []float64, amplitude float64) int {
	if len(xs) == 0 {
		return 0
	}
	reversals := 0
	dir := 0.0
	extreme := xs[0]
	for _, x := range xs[1:] {
		if dir == 0 {
			if abs(x-extreme) >= amplitude {
				dir, extreme = sign(x-extreme), x
			}
			continue
		}
		if (x-extreme)*dir > 0 {
			extreme = x
			continue
		}
		if abs(extreme-x) >= amplitude {
			reversals++
			dir, extreme = -dir, x
		}
	}
	return reversals
}

func abs(x float64) float64 { return max(x, -x) }

func sign(x float64) float64 {
	switch {
	case x > 0:
		return 1
	case x < 0:
		return -1
	}
	return 0
}
