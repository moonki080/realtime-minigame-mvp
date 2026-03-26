# Realtime Minigame MVP

Vercel 배포를 기준으로 다시 정리한 회식용 실시간 미니게임 MVP입니다.  
핵심 구조는 `Vercel Functions(/api)` + 외부 KV/Redis 계열 저장소 + polling 기반 상태 동기화입니다.

## 무엇이 바뀌었나

- 장시간 실행되는 `server.mjs + runtime-state.json` 구조를 버리고 `/api/bootstrap`, `/api/room`, `/api/round`, `/api/player`, `/api/leaderboard` 중심으로 재구성했습니다.
- 파일 저장을 제거하고 `ROOM_STORE_URL`, `ROOM_STORE_TOKEN`, `ROOM_STORE_PREFIX` 기반 외부 저장소를 사용하도록 바꿨습니다.
- 첫 진입 화면은 무한 스피너 대신 `관리자 시작 / 참가자 입장 / 테스트 모드` 홈으로 고정했습니다.
- 관리자/참가자/발표 화면은 SSE 대신 polling으로 상태를 동기화합니다.
- 화이트 베이스 운영 대시보드 톤과 모바일 관리자 하단 액션 바를 유지한 채 새 API 구조에 맞췄습니다.

## 현재 동작 범위

- 관리자 방 생성
- 참가자 방 코드 입장
- 관리자 복구 코드 기반 권한 복구
- 발표 전용 링크 `?room=ROOM&display=1`
- 5라운드 / 8라운드 운영
- 특별상품 사전 입력 및 라운드별 수정
- `ROUND_INTRO -> PRACTICE_PLAY -> PRACTICE_RESULT -> MAIN_INTRO -> MAIN_PLAY -> SCORING -> ROUND_RESULT -> FINAL_RESULT`
- 최종 결과 발표 및 같은 방 새 대회 시작
- 8종 미니게임 클라이언트

## 프로젝트 구조

```text
realtime-minigame-mvp/
  api/
    bootstrap.mjs
    room.mjs
    round.mjs
    player.mjs
    leaderboard.mjs
  lib/
    core/
    store/
    utils/
  public/
    app.mjs
    games.mjs
    styles.css
    index.html
  shared/
    gameData.mjs
  server.mjs
  vercel.json
```

`server.mjs` 는 배포 서버가 아니라 로컬 확인용 adapter 입니다. 실제 배포 기준 런타임은 `/api/*.mjs` 입니다.

## 로컬 실행 방법

### 권장: Vercel dev

```bash
cd /Users/moonkilee/Documents/New\ project/realtime-minigame-mvp
vercel link
vercel env pull .env.local
npm run dev:vercel
```

또는 직접:

```bash
vercel dev --listen 4310
```

### fallback: 로컬 adapter

Vercel CLI 없이 화면과 API를 빠르게 확인할 때:

```bash
cd /Users/moonkilee/Documents/New\ project/realtime-minigame-mvp
npm start
```

기본 접속 주소:

```text
http://127.0.0.1:4310
```

## 환경변수 설정

예시는 [.env.example](/Users/moonkilee/Documents/New project/realtime-minigame-mvp/.env.example)에 있습니다.

필수:

- `ROOM_STORE_URL`: Upstash Redis REST URL 또는 호환 KV/Redis REST endpoint
- `ROOM_STORE_TOKEN`: 저장소 Bearer token
- `ROOM_STORE_PREFIX`: 프로젝트별 key prefix

선택:

- `HOST`: 로컬 adapter 바인드 주소. 기본값 `0.0.0.0`
- `PORT`: 로컬 adapter 포트. 기본값 `4310`
- `PRACTICE_LEAD_IN_MS`: 연습 리드인 시간
- `MAIN_INTRO_MS`: 본게임 카운트다운 시간
- `SCORING_DELAY_MS`: 점수 집계 지연
- `ROOM_TTL_SECONDS`: room key TTL

중요:

- 배포 환경에서는 외부 저장소 환경변수가 사실상 필수입니다.
- 환경변수가 없으면 로컬 adapter 에서만 인메모리 fallback 으로 동작합니다.
- 인메모리 fallback 은 프로세스 재시작 시 상태가 유지되지 않습니다.

## LAN 테스트 방법

1. 관리자 기기에서 `npm run dev:vercel` 또는 `npm start`
2. 관리자 기기의 사설 IP 확인

```bash
ipconfig getifaddr en0
```

3. 관리자 기기에서 `http://127.0.0.1:4310` 또는 `http://내사설IP:4310` 접속
4. 홈에서 `관리자 시작` 선택
5. 방 생성 후 대기실 진입 확인
6. 다른 기기에서 같은 Wi-Fi로 `http://내사설IP:4310` 접속
7. `참가자 입장`으로 방 코드 입력
8. 관리자 화면 참가자 수 반영 확인
9. `대회 시작 -> 연습 시작/건너뛰기 -> 본게임 -> 결과 공개` 흐름 확인

확인 포인트:

- 첫 화면이 즉시 역할 선택 홈으로 뜨는지
- 모바일에서도 관리자 방 생성이 되는지
- 참가자 수가 polling으로 반영되는지
- 모바일 관리자 하단 액션 바 버튼이 잘리지 않는지
- 같은 origin / 상대경로 기반으로 다른 기기에서도 정상 입장되는지

## Smoke Test

기본 흐름 검증:

```bash
npm run smoke
```

이 스크립트는 아래를 확인합니다.

- bootstrap 홈 응답
- 관리자 방 생성
- 참가자 입장
- 발표 화면 bootstrap
- 연습판 / 본게임 / 라운드 결과 / 최종 결과
- leaderboard 응답
- reset-room

외부 저장소 재시작 복구 검증:

```bash
npm run smoke:recovery
```

주의:

- 이 테스트는 `ROOM_STORE_URL`, `ROOM_STORE_TOKEN` 이 설정된 경우에만 실제 재시작 복구를 검증합니다.
- 외부 저장소가 없으면 skip 메시지를 출력하고 종료합니다.

## 배포 방법

1. Vercel 프로젝트 연결

```bash
vercel link
```

2. 환경변수 등록

```text
ROOM_STORE_URL
ROOM_STORE_TOKEN
ROOM_STORE_PREFIX
```

3. 필요하면 로컬로 환경변수 pull

```bash
vercel env pull .env.local
```

4. 배포

```bash
vercel --prod
```

## Vercel 배포 후 확인 방법

1. 배포 URL의 `/` 접속
2. 홈 화면에서 역할 선택 3개 버튼 확인
3. 모바일에서 관리자 시작 후 방 생성
4. 다른 기기에서 참가자 입장
5. 관리자 `대회 시작`
6. 연습판 / 본게임 / 결과 화면 진행 확인
7. 발표 화면은 `?room=ROOMCODE&display=1` 로 확인

## 문제 발생 시 점검 포인트

- 방 생성은 되는데 상태가 유지되지 않으면 `ROOM_STORE_URL`, `ROOM_STORE_TOKEN` 설정을 먼저 확인합니다.
- 로컬 adapter 에서는 재시작 복구가 안 되는 것이 정상입니다. 외부 저장소가 있어야 합니다.
- 다른 기기 접속이 안 되면 서버를 `0.0.0.0` 으로 바인드했는지와 같은 Wi-Fi 인지 확인합니다.
- 배포 환경에서 polling 응답이 늦으면 함수 로그와 외부 저장소 지연을 확인합니다.
- 관리자/참가자 복구가 기대와 다르면 같은 브라우저의 `clientId` 유지 여부를 먼저 확인합니다.

## API 개요

- `POST /api/bootstrap`: 홈 초기화, 세션 복구
- `POST /api/room`: `createRoom`, `joinRoom`, `recoverAdmin`, `getRoomSummary`
- `POST /api/round`: 관리자 액션, 플레이 제출
- `GET /api/player`: 관리자/참가자/발표 화면 polling 상태
- `GET /api/leaderboard`: 라운드 결과 또는 최종 결과

## 남아 있는 제약사항

- 외부 저장소가 없으면 재시작 복구는 지원되지 않습니다.
- bootstrap 복구는 현재 room 목록을 순회해 찾는 방식이라 방 수가 매우 많아지면 비효율적일 수 있습니다.
- QR 이미지는 외부 QR 이미지 서비스를 사용합니다.
- polling 기반 MVP라 완전 실시간 체감은 SSE/WebSocket 보다 느릴 수 있습니다.
