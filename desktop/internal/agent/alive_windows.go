package agent

import "syscall"

const processQueryLimitedInformation = 0x1000

func processAlive(pid int) bool {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	const stillActive = 259
	return syscall.GetExitCodeProcess(h, &code) == nil && code == stillActive
}
