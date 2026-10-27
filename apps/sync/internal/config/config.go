package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port        string
	DatabaseURL string
	RedisURL    string

	// APIBaseURL and InternalServiceSecret configure the call to apps/api's
	// POST /internal/sessions/verify — apps/api is the single source of
	// truth for session validity and effective RBAC permission; this
	// service no longer verifies JWTs or computes the permission matrix
	// itself (see internal/sessionsclient).
	APIBaseURL            string
	InternalServiceSecret string
	SessionVerifyTimeout  time.Duration

	SnapshotDebounce time.Duration
	InstanceID       string
}

func Load() Config {
	debounceMs := 10_000
	if v := os.Getenv("SNAPSHOT_DEBOUNCE_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			debounceMs = n
		}
	}
	sessionVerifyTimeoutMs := 3_000
	if v := os.Getenv("SESSION_VERIFY_TIMEOUT_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			sessionVerifyTimeoutMs = n
		}
	}
	instanceID := os.Getenv("INSTANCE_ID")
	if instanceID == "" {
		instanceID = randomID()
	}
	return Config{
		Port:                  getenv("PORT", "1234"),
		DatabaseURL:           os.Getenv("DATABASE_URL"),
		RedisURL:              getenv("REDIS_URL", "redis://localhost:6379"),
		APIBaseURL:            getenv("API_BASE_URL", "http://localhost:4000"),
		InternalServiceSecret: os.Getenv("INTERNAL_SERVICE_SECRET"),
		SessionVerifyTimeout:  time.Duration(sessionVerifyTimeoutMs) * time.Millisecond,
		SnapshotDebounce:      time.Duration(debounceMs) * time.Millisecond,
		InstanceID:            instanceID,
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func randomID() string {
	// Not cryptographically important — just needs to differ across replicas
	// so redisbus can tell "my own echo" apart from "a peer instance's event".
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "sync-instance"
	}
	return h + "-" + strconv.Itoa(os.Getpid())
}
