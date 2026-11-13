// Package sourceexport is the once-only reader for an existing Electron profile.
// It never launches source application code. Chromium opens only the clone.
package sourceexport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
)

type Options struct {
	ElectronApp   string
	SourceProfile string
	Output        string
	Preferences   bool
	Credentials   bool
}

type Result struct {
	Path                string `json:"path"`
	AttachmentCount     any    `json:"attachmentCount"`
	SourceVersion       string `json:"sourceVersion"`
	SourceAppSHA256     string `json:"sourceAppSha256"`
	SourceProfileSHA256 string `json:"sourceProfileSha256"`
	SourceUnchanged     bool   `json:"sourceUnchanged"`
	PreferencesIncluded bool   `json:"preferencesIncluded"`
	CredentialsIncluded bool   `json:"credentialsIncluded"`
}

type helperConfig struct {
	Profile  string                       `json:"profile"`
	Scratch  string                       `json:"scratch"`
	Output   string                       `json:"output"`
	Error    string                       `json:"error"`
	Options  map[string]bool              `json:"options"`
	Metadata map[string]services.Metadata `json:"metadata"`
}

type cappedLog struct{ bytes.Buffer }

func (log *cappedLog) Write(value []byte) (int, error) {
	count := len(value)
	if log.Len() < 16384 {
		log.Buffer.Write(value[:min(len(value), 16384-log.Len())])
	}
	return count, nil
}

func command(ctx context.Context, executable string, arguments ...string) (string, error) {
	cmd := exec.CommandContext(ctx, executable, arguments...)
	var output cappedLog
	cmd.Stdout, cmd.Stderr = &output, &output
	err := cmd.Run()
	if err != nil {
		return "", fmt.Errorf("%s failed: %w (%s)", filepath.Base(executable), err, output.String())
	}
	return strings.TrimSpace(output.String()), nil
}

func Run(ctx context.Context, options Options) (result *Result, err error) {
	if runtime.GOOS != "darwin" {
		return nil, fmt.Errorf("installed Electron source export currently requires macOS")
	}
	deadline, stop := context.WithTimeout(ctx, 10*time.Minute)
	defer stop()
	ctx, cancel := context.WithCancelCause(deadline)
	defer cancel(nil)
	defer func() {
		if err != nil && context.Cause(ctx) != nil {
			err = context.Cause(ctx)
		}
	}()
	application, profile, output, err := validatePaths(options)
	if err != nil {
		return nil, err
	}
	files, err := payloadFiles()
	if err != nil {
		return nil, err
	}
	if err := closedProfile(profile); err != nil {
		return nil, err
	}
	if err := noProfileUsers(ctx, profile); err != nil {
		return nil, err
	}
	plist := filepath.Join(application, "Contents", "Info.plist")
	identity, err := command(ctx, "/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", plist)
	if err != nil || identity != "com.bike.app" {
		return nil, fmt.Errorf("--electron-app must identify the original com.bike.app application")
	}
	version, err := command(ctx, "/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist)
	if err != nil || (version != "2.0.0" && version != "2.0.1") {
		return nil, fmt.Errorf("source exporter requires the installed Electron Bike 2.0.0 or 2.0.1 application")
	}
	executable, err := command(ctx, "/usr/bin/plutil", "-extract", "CFBundleExecutable", "raw", "-o", "-", plist)
	if err != nil || executable == "" || filepath.Base(executable) != executable {
		return nil, fmt.Errorf("source application executable is invalid")
	}
	profileDigest, err := fingerprint(ctx, profile, false)
	if err != nil {
		return nil, err
	}
	appDigest, err := fingerprint(ctx, application, true)
	if err != nil {
		return nil, err
	}
	tempParent, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		return nil, err
	}
	if within(profile, tempParent) || within(application, tempParent) {
		return nil, fmt.Errorf("临时目录不能位于源 app 或 profile 内")
	}
	temporary, err := os.MkdirTemp(tempParent, "bike-source-export-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temporary)
	// Poll lock files throughout copying and export. Final fingerprints also
	// detect a racing writer that started and stopped between polls.
	watchCtx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				if err := closedProfile(profile); err != nil {
					cancel(err)
					return
				}
			}
		}
	}()
	defer func() { stopWatch(); <-watchDone }()
	verifySource := func() error {
		if err := closedProfile(profile); err != nil {
			return err
		}
		if err := noProfileUsers(ctx, profile); err != nil {
			return err
		}
		digest, err := fingerprint(ctx, profile, false)
		if err != nil {
			return err
		}
		if digest != profileDigest {
			return fmt.Errorf("源 profile 在快照期间发生变化，导出已取消")
		}
		digest, err = fingerprint(ctx, application, true)
		if err != nil {
			return err
		}
		if digest != appDigest {
			return fmt.Errorf("源应用在导出期间发生变化，导出已取消")
		}
		return closedProfile(profile)
	}
	clonedProfile := filepath.Join(temporary, "profile")
	if err := copyTree(ctx, profile, clonedProfile, false); err != nil {
		return nil, err
	}
	if err := verifySource(); err != nil {
		return nil, err
	}
	helperApp := filepath.Join(temporary, "Source Export.app")
	if err := copyTree(ctx, application, helperApp, true); err != nil {
		return nil, err
	}
	resourceDirectory := filepath.Join(helperApp, "Contents", "Resources", "app")
	if err := os.Mkdir(resourceDirectory, 0700); err != nil {
		return nil, err
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(resourceDirectory, name), content, 0600); err != nil {
			return nil, err
		}
	}
	helperPlist := filepath.Join(helperApp, "Contents", "Info.plist")
	if _, err := command(ctx, "/usr/bin/plutil", "-replace", "CFBundleIdentifier", "-string", "com.bike.source-export", helperPlist); err != nil {
		return nil, err
	}
	if _, err := command(ctx, "/usr/bin/codesign", "--force", "--deep", "--sign", "-", helperApp); err != nil {
		return nil, err
	}
	library := services.NewAttachments(filepath.Join(clonedProfile, "attachments"))
	metadata, err := attachmentMetadata(ctx, library)
	if err != nil {
		return nil, err
	}
	config := helperConfig{
		Profile: clonedProfile, Scratch: temporary,
		Output: filepath.Join(temporary, "workspace.json"), Error: filepath.Join(temporary, "error.txt"),
		Options: map[string]bool{"preferences": options.Preferences, "credentials": options.Credentials}, Metadata: metadata,
	}
	configBytes, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	configPath := filepath.Join(temporary, "config.json")
	if err := os.WriteFile(configPath, configBytes, 0600); err != nil {
		return nil, err
	}
	if err := runHelper(ctx, filepath.Join(helperApp, "Contents", "MacOS", executable), configPath, temporary); err != nil {
		if failure, readErr := readBounded(config.Error, 4096); readErr == nil {
			return nil, fmt.Errorf("读取源副本失败：%s", failure)
		}
		return nil, err
	}
	raw, err := readBounded(config.Output, int64(contracts.Limits.DocumentBytes))
	if err != nil {
		return nil, err
	}
	if _, workspace, _, err := services.WorkspaceJSON(raw); err != nil {
		return nil, err
	} else if workspace["localMigration"] == nil {
		return nil, fmt.Errorf("源读取进程没有返回完整本机副本")
	}
	stagedArchive := filepath.Join(temporary, "export.zip")
	exported, err := services.ExportArchive(ctx, stagedArchive, raw, nil, library)
	if err != nil {
		return nil, err
	}
	err = services.AtomicFile(ctx, output, func(destination io.Writer) error {
		file, err := os.Open(stagedArchive)
		if err != nil {
			return err
		}
		defer file.Close()
		if _, err := copyContext(ctx, destination, file); err != nil {
			return err
		}
		return verifySource()
	})
	if err != nil {
		return nil, err
	}
	return &Result{Path: output, AttachmentCount: exported["attachmentCount"], SourceVersion: version,
		SourceAppSHA256: appDigest, SourceProfileSHA256: profileDigest, SourceUnchanged: true,
		PreferencesIncluded: options.Preferences, CredentialsIncluded: options.Credentials}, nil
}

func validatePaths(options Options) (string, string, string, error) {
	paths := []string{options.ElectronApp, options.SourceProfile, options.Output}
	for index, name := range paths {
		if name == "" {
			return "", "", "", fmt.Errorf("--export-electron-profile requires --electron-app, --source-profile and --output")
		}
		absolute, err := filepath.Abs(name)
		if err != nil {
			return "", "", "", err
		}
		if index < 2 {
			info, err := os.Lstat(absolute)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return "", "", "", fmt.Errorf("源 app 和 profile 必须是实际目录")
			}
			absolute, err = filepath.EvalSymlinks(absolute)
			if err != nil {
				return "", "", "", err
			}
		} else {
			parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
			if err != nil {
				return "", "", "", err
			}
			absolute = filepath.Join(parent, filepath.Base(absolute))
		}
		paths[index] = absolute
	}
	if within(paths[0], paths[1]) || within(paths[1], paths[0]) ||
		within(paths[0], paths[2]) || within(paths[1], paths[2]) {
		return "", "", "", fmt.Errorf("源 app、源 profile 和输出必须彼此隔离")
	}
	return paths[0], paths[1], paths[2], nil
}

func readBounded(name string, maximum int64) ([]byte, error) {
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, fmt.Errorf("源读取结果无效或超过预算")
	}
	value, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if len(value) > int(maximum) {
		return nil, fmt.Errorf("源读取结果超过预算")
	}
	return value, err
}

var originalName = regexp.MustCompile(`^[a-f0-9]{64}$`)

func attachmentMetadata(ctx context.Context, library *services.Attachments) (map[string]services.Metadata, error) {
	result := map[string]services.Metadata{}
	err := filepath.WalkDir(library.Directory, func(name string, entry os.DirEntry, walkErr error) error {
		if os.IsNotExist(walkErr) {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || !originalName.MatchString(entry.Name()) {
			return nil
		}
		if len(result) >= 10000 {
			return fmt.Errorf("附件元数据超过 10,000 项处理预算")
		}
		id := "sha256:" + entry.Name()
		file, metadata, err := library.Open(id, nil)
		if err == nil {
			file.Close()
			result[id] = metadata
		}
		// Unreferenced corrupt originals do not prevent export. Any referenced
		// original must pass Open again when Go creates the complete archive.
		return nil
	})
	return result, err
}

// lsof detects open databases even when a nonstandard source launch omitted the
// Chromium singleton lock. It only observes handles and never opens the profile.
func noProfileUsers(ctx context.Context, profile string) error {
	cmd := exec.CommandContext(ctx, "/usr/sbin/lsof", "-n", "-P", "-t", "+D", profile)
	var output, diagnostic cappedLog
	cmd.Stdout, cmd.Stderr = &output, &diagnostic
	err := cmd.Run()
	if output.Len() != 0 {
		return fmt.Errorf("源 profile 仍被进程使用，请完全退出源应用后重试")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 && output.Len() == 0 && diagnostic.Len() == 0 {
		return nil
	}
	return fmt.Errorf("无法确认源 profile 已关闭：%v %s", err, diagnostic.String())
}
