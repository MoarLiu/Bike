//go:build darwin || linux

package sourceexport

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func runHelper(ctx context.Context, executable, config, temporary string) error {
	cmd := exec.CommandContext(ctx, executable, "--bike-export-config="+config)
	// A fresh process group contains only our copied helper and its children.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + temporary, "TMPDIR=" + temporary,
		"LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8"}
	cmd.Dir = temporary
	var log cappedLog
	cmd.Stdout, cmd.Stderr = &log, &log
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Start(); err != nil {
		return err
	}
	defer syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("isolated source reader failed: %w (%s)", err, log.String())
	}
	return nil
}
