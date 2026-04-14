package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"strings"
)

//go:embed public/*
var embeddedPublic embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:4017", "listen address")
	dataDir := flag.String("data-dir", "data", "directory for local data")
	flag.Parse()

	appStore, err := newStore(*dataDir)
	if err != nil {
		log.Fatalf("init store: %v", err)
	}
	defer func() {
		if err := appStore.close(); err != nil {
			log.Printf("close store: %v", err)
		}
	}()

	publicFS, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		log.Fatalf("sub fs: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
			return
		}
		state, err := appStore.summarize()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server-error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, state)
	}))

	mux.HandleFunc("/api/capture", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
			return
		}
		var payload capturePayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-request", "message": err.Error()})
			return
		}
		response, err := appStore.processCapture(payload)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server-error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, response)
	}))

	mux.HandleFunc("/api/pause", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
			return
		}
		var input struct {
			Paused bool `json:"paused"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-request", "message": err.Error()})
			return
		}
		state, err := appStore.updatePaused(input.Paused)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server-error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, state)
	}))

	mux.HandleFunc("/api/blacklist", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
			return
		}
		var rule blacklistRule
		if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-request", "message": err.Error()})
			return
		}
		state, err := appStore.addBlacklistRule(rule)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad-request", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, state)
	}))

	mux.HandleFunc("/api/blacklist/", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method-not-allowed"})
			return
		}
		ruleID := strings.TrimPrefix(r.URL.Path, "/api/blacklist/")
		state, err := appStore.deleteBlacklistRule(ruleID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server-error", "message": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, state)
	}))

	fileServer := http.FileServer(http.FS(publicFS))
	mux.Handle("/", withCORS(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			r.URL.Path = "/index.html"
		}
		fileServer.ServeHTTP(w, r)
	}))

	log.Printf("People Dream demo server running at http://%s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
