package pick

import (
	"regexp"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var blockedTitle = regexp.MustCompile(`(?i)密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay`)

// blockedReason says why Pointy keeps out of the foreground window, or is
// empty when it may read it.
func blockedReason(d desktop.Desktop, fg desktop.Foreground) string {
	if d.Blocked(fg.Exe) {
		return fg.Exe + " 在黑名单里"
	}
	if blockedTitle.MatchString(fg.Title) {
		return "窗口像是登录或密码页面"
	}
	return ""
}
