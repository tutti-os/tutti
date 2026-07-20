package agentextension

import (
	"debug/elf"
	"debug/macho"
	"debug/pe"
	"errors"
	"fmt"
	"os"
	"strings"
)

func validateNativeExecutablePlatform(path, platform string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return validateNativeExecutableFile(file, platform)
}

func validateNativeExecutableFile(file *os.File, platform string) error {
	osName, architecture, ok := strings.Cut(platform, "-")
	if !ok || osName == "" || architecture == "" {
		return errors.New("native executable platform identity is invalid")
	}
	switch osName {
	case "darwin":
		parsed, err := macho.NewFile(file)
		if err != nil {
			return fmt.Errorf("runtime artifact is not a Mach-O executable: %w", err)
		}
		defer parsed.Close()
		want := macho.CpuAmd64
		if architecture == "arm64" {
			want = macho.CpuArm64
		} else if architecture != "amd64" {
			return fmt.Errorf("unsupported Mach-O architecture %s", architecture)
		}
		if parsed.Cpu != want {
			return fmt.Errorf("Mach-O architecture is %s, want %s", parsed.Cpu, want)
		}
	case "linux":
		parsed, err := elf.NewFile(file)
		if err != nil {
			return fmt.Errorf("runtime artifact is not an ELF executable: %w", err)
		}
		defer parsed.Close()
		want := elf.EM_X86_64
		if architecture == "arm64" {
			want = elf.EM_AARCH64
		} else if architecture != "amd64" {
			return fmt.Errorf("unsupported ELF architecture %s", architecture)
		}
		if parsed.Machine != want {
			return fmt.Errorf("ELF architecture is %s, want %s", parsed.Machine, want)
		}
	case "windows":
		parsed, err := pe.NewFile(file)
		if err != nil {
			return fmt.Errorf("runtime artifact is not a PE executable: %w", err)
		}
		defer parsed.Close()
		want := uint16(pe.IMAGE_FILE_MACHINE_AMD64)
		if architecture == "arm64" {
			want = pe.IMAGE_FILE_MACHINE_ARM64
		} else if architecture != "amd64" {
			return fmt.Errorf("unsupported PE architecture %s", architecture)
		}
		if parsed.Machine != want {
			return fmt.Errorf("PE architecture is %#x, want %#x", parsed.Machine, want)
		}
	default:
		return fmt.Errorf("native executable verification is unsupported on %s", platform)
	}
	return nil
}
