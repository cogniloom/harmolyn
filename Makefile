.PHONY: up down restart logs build

up:
	docker compose up -d --build

down:
	docker compose down

restart: down up

logs:
	docker compose logs -f

build:
	docker compose build
