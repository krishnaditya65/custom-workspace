# Multi-stage build producing a minimal static binary — no Node.js runtime
# needed for this service, unlike apps/api and apps/web.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/sync ./cmd/sync

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/sync /sync
EXPOSE 1234
ENTRYPOINT ["/sync"]
