# Presentation Notes — LLM Context Harness

> Talking points for a live demo. Each section is what to say + the
> evidence to point at. Times approximate for a 7–10 minute slot.

---

## 1. The problem (90s)

> "한 LLM 도구에서 다른 도구로 대화를 그대로 들고 가고 싶다."

- Claude Code에서 며칠을 쌓아온 컨텍스트가 있는데, 같은 작업을 Codex
  CLI(GPT 계열)로 이어가고 싶은 순간이 옴. 모델 비교, 가격, 한계, 다른
  사람한테 인계 — 이유는 많음.
- 둘 다 세션을 로컬 파일에 쌓는 구조라서 *원리적으로는* 가능해야 함.
- 그런데 두 도구의 세션 포맷은 **공식 문서가 없고**, 둘 사이를 잇는
  도구도 없음.

→ "그럼 직접 만들어 보자"가 이 프로젝트.

---

## 2. 접근 — 3단계 파이프라인 (60s)

```
Source tool   ⇄  NormalizedContext  ⇄  Target tool
                 (우리 공통 스키마)
   extract                              inject
   SourceAdapter                        TargetAdapter
```

- 어댑터 인터페이스 두 개 (`SourceAdapter`, `TargetAdapter`).
- 한 클래스가 **양쪽 다 구현 가능** — Claude Code 어댑터, Codex 어댑터
  둘 다 source + target.
- v0.1 범위: **Claude Code ⇄ Codex 양방향**, tool 호출 schema까지 변환.

---

## 2.5. 어디에 저장되는가 — 표 한 장 (60s)

발표 중에 "근데 그 컨텍스트가 어디 있는데?" 라는 질문 자주 나옴. 미리
정리해둠:

| 도구·진입점 | 로컬 파일 | 부가 |
|---|---|---|
| Claude Code (CLI) | `~/.claude/projects/<cwd>/<uuid>.jsonl` | hook 로그 포함 |
| Codex CLI (`codex` 명령) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `state_5.sqlite` | UTC 폴더, sqlite는 인덱스/메모리 |
| Codex (VS Code 확장) | 위 + `~/.vscode/extensions/openai.chatgpt-*/bin/.../codex.exe` 자체 바이너리 + VS Code globalStorage/workspaceStorage | 로컬 파일은 같음, UI 상태만 별도 |
| Codex 웹/앱 | (로컬 캐시만) | 본 컨텍스트는 OpenAI 서버 |

요점:
- CLI든 VS Code든 둘 다 결국 **`~/.codex`**에 수렴 (같은 CODEX_HOME).
- 그래서 우리 어댑터 하나가 두 진입점 다 커버함.
- 웹/앱 컨텍스트는 우리 도구로 못 빼옴 (서버 측). v1에서 OpenAI API
  scrape 하거나 사용자가 export 후 import 해야 함.

---

## 3. 발견 1 — 두 도구의 실제 포맷 (2분, 핵심)

> 가장 가치 있는 부분. **공식 문서가 없는 걸 직접 까서 확인했다.**

### Claude Code 세션 JSONL
- 위치: `~/.claude/projects/<cwd-as-folder-name>/<session-uuid>.jsonl`
- 한 세션 = 한 JSONL. 라인마다 한 이벤트.
- **놀라운 사실**: `type: "user" | "assistant"` 라인은 **소수**. 대부분은
  `"attachment"` (hook 결과, skill 리스팅, 도구 deferred 메타). 그대로
  옮기면 transcript가 노이즈로 폭발 → **필터링 필수**.
- **숨은 함정**: 한 어시스턴트 turn이 **여러 라인으로 쪼개져** 저장됨
  (`thinking` / `text` / `tool_use` 블록 각각). `message.id`로 묶어줘야
  함.
- 모델 이름은 `message.model` 안에 (예: `claude-opus-4-7`).

### Codex CLI rollout JSONL
- 위치: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (UTC).
- 모든 라인이 `{timestamp, type, payload}`로 wrap돼 있음.
- 첫 줄은 `type: "session_meta"` — id, cwd, model_provider, base_instructions.
- 메시지 라인은 `type: "response_item"`,
  `payload.role` ∈ {user, assistant, **developer**} (developer는 권한·모드 정보).
- 사용자 메시지는 **두 번 기록됨** — `response_item`으로 한 번, 또
  `event_msg(user_message)`로 한 번. 이유는 모름. 우리도 양쪽 다 씀.

→ "양쪽 다 reverse-engineering으로만 알 수 있었음. 우리 OPEN_QUESTIONS.md
  가 다른 사람한테 reference 역할 할 수 있음."

---

## 4. 발견 2 — Codex가 알아서 등록함 (90s)

> 의외였던 부분. 코드 더 짤 줄 알았는데 안 짜도 됐음.

- 처음 시도 후 stderr에 빨간 글씨로:
  ```
  ERROR codex_core::session: failed to record rollout items:
  thread <uuid> not found
  ```
- "아, sqlite 같은 별도 인덱스가 있고 거기 row를 안 만들어서 실패했나
  보다" → `~/.codex/state_5.sqlite` 까봄.
- 거기 `threads` 테이블 (27 컬럼) 발견. 우리 세션 row 있는지 조회 →
  **YES, 이미 있음**.
- 즉 Codex가 첫 resume 시도 중 자동으로 row를 INSERT 해줬음. 우리가
  session_meta에 박은 `cli_version: "0.0.1"`까지 그대로 가져감.

→ "그러니까 우리 어댑터에 sqlite INSERT 코드를 안 짜도 됐다. 라이브러리
  의존성 제로로 끝냄."

---

## 5. 발견 3 — "에러"가 사실 거짓말 (90s)

> 발표 중 가장 임팩트 있는 부분.

- 빨간 글씨 무서워서 "write-back은 안 되는 거구나" 결론냈었음 →
  README/OPEN_QUESTIONS에 "v1 작업"으로 미뤘음.
- 그런데 다시 한번 검증: rollout 파일 크기 측정 → 두번째 resume 후
  **315,213 bytes → 319,180 bytes로 4KB 증가**.
- `tail -3`으로 보니 새 `response_item` (assistant 응답), `token_count`,
  `task_complete` 라인이 **정상적으로 append됨**.
- 즉 "thread not found"는 *보조* 메모리/요약 테이블 (`stage1_outputs`)
  동기화 실패. **메인 기능은 정상 동작**.

→ "에러 메시지는 신뢰하지 말고 *결과*를 측정해야 한다는 교훈."

---

## 6. 데모 (90s)

라이브 시연 가능 (인터넷·인증 멀쩡할 때). 미리 캡처도 준비.

```bash
# 1. Claude Code 세션을 Codex 포맷으로 변환
node dist/cli/index.js pipe \
  --from claude-code \
  --session 8131efb2-19ac-407b-a538-8d94a94258e5 \
  --to codex
# → Extracted 69 messages from claude-code (claude-opus-4-7)
# → Injected to: ~/.codex/sessions/.../rollout-...-68331f71-....jsonl

# 2. Codex(gpt-5.5)로 resume, 첫 메시지 회상 시켜봄
codex exec --skip-git-repo-check resume \
  68331f71-4c9b-4d9e-a79a-979bbaa62ca2 \
  "이 세션의 첫 메시지가 무엇이었는지 한 줄로 답해줘"
```

**응답 (gpt-5.5):**
> "나는 이제 llm의 context를 추출하고 다른 llm에 삽입할 수 있도록
> 변환하고 삽입하는 것을 할거야. 너가 도와주면 좋겠어. 미리 클로드와함께
> 큰 틀을만들었어"

→ 이건 사용자가 Claude Code에서 처음 친 한국어 메시지와 **글자 단위로
  일치**. 모델만 바뀌었지 컨텍스트는 그대로 이어짐.

---

## 6.5. 발견 4 — 양방향과 도구 호출까지 (90s)

> v0 끝났다고 생각했는데 한 사이클 더 돌면서 추가된 부분.

- **양방향 어댑터**: 같은 클래스가 `SourceAdapter`와 `TargetAdapter`를
  둘 다 구현. 이제:
  ```bash
  # 정방향
  harness pipe --from claude-code --session <id> --to codex
  # 역방향 — Codex에서 작업하다가 Claude Code로 인계
  harness pipe --from codex --session <uuid> --to claude-code
  ```
  158메시지짜리 실제 Codex 세션을 Claude Code JSONL로 변환했고,
  **`claude --resume` picker에 정상 등록 확인** (size 288.9KB와 첫 user
  메시지 둘 다 정확히 일치). 즉 read 만이 아니라 picker까지 수용.

- **Tool 호출 schema 변환** (이전엔 텍스트로 평탄화했던 것):

  | Anthropic | OpenAI Responses |
  |---|---|
  | `tool_use { id, name, input: object }` | `function_call { call_id, name, arguments: string-JSON }` |
  | `tool_result { tool_use_id, content, is_error }` | `function_call_output { call_id, output: string }` (`[error] ` prefix 시) |

  주의할 함정:
  - **`arguments`는 string** (object 아님) — JSON.stringify 한 결과.
  - **`is_error`가 OpenAI엔 없음** — output 텍스트에 prefix로 인코딩.
  - **field 이름이 다름** — `id` ↔ `call_id`, `tool_use_id` ↔ `call_id`.

- **Round-trip 테스트로 보증**: Norm → Codex → Norm, Norm → Claude Code
  → Norm 둘 다 `id`, `name`, `input`, `output` 모두 보존 확인.

- **Claude Code 폴더명 인코딩의 함정** (작지만 중요):
  cwd `C:\Users\ddoon\Desktop\context_switching` →
  폴더 `C--Users-ddoon-Desktop-context-switching`. 즉 `:`, `\`, `/`,
  **그리고 `_`까지** 모두 `-`로 치환. 언더스코어 변환은 비명세 동작이라
  몰랐으면 한참 디버깅했을 부분.

→ "정방향만 만들었다가 발견을 한 사이클 더 돌리니 양방향 + 도구까지
  되더라. 그리고 폴더 인코딩 같은 작은 함정이 한참 시간 잡아먹는다."

---

## 7. 한계와 다음 (45s)

정직하게 말할 것:

- `parentUuid` 브랜치 처리 안 함 (file order로만 읽음). 분기 있는
  세션은 평탄화됨.
- Thinking 블록은 의도적으로 drop (다른 모델이 자기 thinking으로 오해할
  수 있음).
- 새 세션 메타에 `originator: "harness-import"`로 박지만 Codex는
  이걸 모르므로 sqlite `source` 컬럼에 `unknown`으로 들어감. 기능엔 영향 없음.
- Auto-resume by id가 Claude Code엔 없어서, 사용자가 `claude --resume`
  picker에서 직접 선택해야 함.
- Cursor, ChatGPT 웹 export, Gemini는 v1+.
- 시크릿 redactor 미구현 (세션에 토큰/패스워드 들어있으면 그대로 옮겨감).

---

## 8. 한 줄 결론

> 두 도구의 *비공식* 포맷을 reverse-engineer 해서, 컨텍스트가 모델·도구
> 사이를 건너뛸 수 있게 만들었다. 양쪽 다 sqlite 인덱스나 비공식 키워드
> 처리 같은 함정이 있었지만, **에러 메시지에 속지 않고 결과를 측정**한
> 덕분에 sqlite 코드 한 줄 안 짜고 끝냈다.

---

## Q&A 대비

| 예상 질문 | 짧은 답 |
|---|---|
| "왜 단순히 transcript를 텍스트로 던져넣지 않았나?" | 그게 fallback 모드 (`--as-prompt`). 하지만 native session으로 들어가야 모델이 "이건 진짜 이전 대화"로 인식하고 토큰 캐싱·추론 효율이 살아남. |
| "format이 바뀌면?" | OPEN_QUESTIONS.md에 검증 절차가 있음. 한 세션 까보고 어댑터 두 함수 (parseLine, messageToResponseItem) 고치면 됨. v0의 디자인 자체가 "format은 변한다"는 가정. |
| "양방향(Codex → Claude Code)도 되나?" | 이미 됨 (v0.1). 같은 어댑터 클래스가 양 인터페이스 다 구현. 위 6.5 섹션 라이브 데모로 보여줌. |
| "왜 sqlite 자동 등록을 발견하기까지 한 사이클을 돌았나?" | 처음엔 "에러 = 실패"라고 가정함. 두 번째에서 *파일 사이즈와 line tail로 결과를 직접 측정*하니까 진실이 보였음. 디버깅에서 가정 대신 측정. |
