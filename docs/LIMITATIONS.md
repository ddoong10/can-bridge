# Limitations — can-bridge (Claude Code ⇄ Codex 컨텍스트 이전)

> 중간발표 기준 분석. 작성: Claude Code + Codex(gpt-5.5) 교차 검증.
> 목적: can-bridge 파이프라인 자체의 한계를 정직하게 정리 —
> "우리가 무엇을 못 잡는가(추출 한계)"와 "변환해도 왜 그대로 안
> 붙는가(이식 한계)". 평가 방법론이 아니라 *도구 자체*의 한계만 다룸.

## 0. 한 줄 명제

can-bridge는 **눈에 보이는 대화 transcript(텍스트·도구 호출·도구 출력)** 를
옮긴다. 옮기지 못하는 것은 **에이전트의 정체성·실행 상태·숨은 프롬프트·
워크스페이스 스냅샷·내부 추론**이다. 즉 이것은 *session migration*이 아니라
*context import*다. 이 구분이 모든 한계의 뿌리다.

단, "reasoning"은 구분해서 말해야 한다. Codex rollout에 **기록된**
`reasoning`/`turn_context`/`event_msg` 같은 native artifact는 같은 Codex로
돌아갈 때 보존할 수 있다(§1.6의 native replay). 반대로 KV cache, attention
state, vendor hidden prompt, 모델 내부 scratchpad처럼 **실행 중에만 존재하는**
상태는 세션 파일에 export 가능한 형태로 존재하지 않으므로 복제 대상이 아니다.
그래서 목표는 "동일한 agent identity 복제"가 아니라, 실제 작업을 이어가는 데
충분한 **practical continuity**를 높이는 것이다.

분류 기준:
- **추출 한계(Extraction)** — 소스 파일/런타임에 없거나, 있어도 우리가 안 잡는 것.
- **이식 한계(Injection/Transform)** — 잡아서 변환해도 타겟에서 같은 의미로 안 붙는 것.
- **근본 한계(Fundamental)** — 포맷을 완벽히 맞춰도 원리적으로 불가능한 것.

---

## 1. 추출 한계 — 소스에서 애초에 못 가져오는 것

### 1.1 transcript 라인은 소수, 나머지는 버려진다 (실측)
실제 세션(`448af591…jsonl`, 이 프로젝트 작업 세션) 측정:

> **방향 무관 주의**: 추출 한계는 **소스 도구에만** 의존한다(타겟은 §2
> 이식에서만 관여). 따라서 `claude→codex`와 `claude→claude`는 추출 손실이
> **동일**하고(둘 다 Claude 추출기), `codex→claude`와 `codex→codex`도 동일
> (둘 다 Codex 추출기). 방향별 정리는 §1.6 참조.

- 전체 **181줄 중 user/assistant 메시지 라인은 60줄(33%)**.
- 정규화 후 최종 **26 메시지**.
- 버려지는 라인 타입(실측 빈도): `attachment`(81), `hook_success`(55),
  `hook_additional_context`(22), `tools_changed`(4), `tool_reference`(3),
  `task_reminder`(2), `system`(2), `skill_listing`(1),
  `deferred_tools_delta`(1), `file-history-snapshot`, `permission-mode`.

#### "다 가져오면 성능이 오르지 않나?" — 아니다 (실측 근거)
큰 세션 측정에서 버려지는 라인의 **바이트 대부분이 대화가 아니라 런타임
스캐폴딩**이었다:

| 라인 타입 | 줄 | 바이트 | 정체 | 가져올 가치 |
|---|---|---|---|---|
| `attachment`(hook_success) | 多 | **194KB** | 훅 실행 결과(예: "Read in parallel" 리마인더) | ❌ 노이즈 |
| `file-history-snapshot` | 8 | 3.6KB | 파일 상태 스냅샷(디스크와 중복) | ❌ |
| `last-prompt` | 22 | 7.5KB | `{leafUuid, sessionId}` 포인터 — **내용 0** | ❌ 순수 인덱스 |
| `mode`/`permission-mode`/`ai-title` | 각 22 | — | UI/권한/제목 메타 | ❌ |
| `system` | 8 | — | `/resume` 등 슬래시 명령 UI | ❌ 대부분 |
| `attachment`(hook_additional_context) | 일부 | — | **훅이 모델에 주입한 실제 컨텍스트** | ✅ 선별 가치 |

다 가져오면 오히려 **나빠지는** 이유:
1. **노이즈 희석** — 194KB 훅 로그가 실제 대화를 묻어버림. 모델 주의력 분산
   ("lost in the middle").
2. **토큰 비용** — 타겟 컨텍스트 윈도우는 유한. 스캐폴딩이 정작 중요한
   내용을 밀어냄.
3. **포맷 무효** — Claude `file-history-snapshot`/`permission-mode`는 Codex엔
   의미 없는 쓰레기. 대화로 주입하면 오해 유발.
4. **분기 모순** — message 라인이라도 추출기는 한 분기(latest leaf)만 택함.
   전 분기를 다 넣으면 *서로 모순되는 평행 대화*가 됨(§1.4).

→ 결론: "전부"는 틀렸다. 단 **`hook_additional_context`처럼 실제 모델 입력인
소수 타입은 선별 복구하면 충실도가 오른다**(현재 미구현, tier-B 개선거리).

### 1.2 숨은/암묵 컨텍스트는 파일에 없다
- **시스템 프롬프트** (Claude Code / Codex 각각의 내장 프롬프트) — 세션 파일에
  기록되지 않음. 추출 불가.
- **CLAUDE.md / AGENTS.md / 프로젝트 규칙** — 모델 행동을 크게 좌우하지만
  세션 JSONL에 본문이 안 들어감. 우리는 경로/해시조차 안 잡는다.
- **가용 도구 목록 / MCP 서버 정의** — 어떤 도구가 있었는지 자체가 컨텍스트인데
  전이 안 됨. (1.4도 참조)

### 1.3 멀티모달·바이너리·내부 추론은 잡아도 버린다
- **이미지/첨부**: `[image attachment dropped on cross-tool transfer]`
  플레이스홀더로 대체. "아까 그 이미지" 질문은 복구 불가.
- **thinking(추론) 블록**: inject 시 **의도적으로 drop** (Claude thinking은
  서명된 아티팩트라 타 벤더에서 무효). 실측에서 소스 8개 → Codex 출력 0개.
  결정의 "왜"가 사라지고 결론만 남는다.

### 1.4 분기(branch)·서브에이전트는 한 갈래만 남는다
- Claude `parentUuid`는 트리. 추출기는 **최신 leaf 한 chain만** 선택 →
  나머지 형제 분기는 통째로 누락. "최신 timestamp = 사용자가 원한 분기"라는
  가정은 틀릴 수 있다(분기 후 옛 갈래로 돌아간 경우).
- `isSidechain`(Task/서브에이전트 대화)도 메인 체인에 안 들어오면 사라진다.

### 1.5 이미 압축된 세션은 원본이 없다
Claude Code가 자동 compaction(요약)을 한 세션이면 소스 파일 자체에 이미
원본 디테일이 없다. `summary` 라인 타입은 우리 샘플에서 미관측 — 긴 세션에서
재확인 필요(OPEN_QUESTIONS 미해결 항목).

### 1.6 방향별 추출 손실 — 소스가 무엇이냐로 결정된다
추출 손실은 **소스 도구의 함수**다. 타겟은 추출 단계에 영향을 주지 않는다.

**소스 = Claude Code** (`claude→codex`, `claude→claude` 공통):
- user/assistant 외 모든 라인 폐기: `attachment`(hook), `system`(슬래시 명령),
  `tools_changed`, `skill_listing`, `deferred_tools_delta`, `task_reminder`,
  `file-history-snapshot`, `permission-mode`, `mode`, `ai-title`, `last-prompt`.
- 분기는 latest-leaf 하나만, sidechain(서브에이전트) 누락.
- `gitBranch`는 소스에 있으나 normalized로 안 옮김(cwd/model/sessionId만).
- 이미지 → 플레이스홀더.

**소스 = Codex** (`codex→claude`, `codex→codex` 공통):
- 폐기: `event_msg`(task_started/task_complete/token_count/error),
  **reasoning 아이템**(Codex의 추론), `web_search_call`, 그리고 `turn_context`의
  per-turn 설정(model/reasoning_effort 등 — model 외 미보존).
- `developer` role → normalized `system`으로 접힘(지시 우선순위 의미 희석).
- base_instructions → `summary` 한 덩어리로 평탄화(구조 손실).
- Claude보다 보조 라인이 적어 *상대적으로* 손실이 작지만, 추론·턴 설정 손실은
  더 큼.

**normalized 경로만 쓰면 같은 도구 왕복도 무손실이 아니다** — 스키마가 최소공통분모라서:
- `claude→claude`(normalized): **thinking 폐기**, hook/attachment 라인 소실, 분기 1개로 축소, uuid 체인 재생성.
- `codex→codex`(normalized): reasoning·token_count·turn_context per-turn 설정 소실.

> 그래서 **같은 도구로 돌아갈 땐 normalized를 우회**하는 native 보존을 추가했다(아래).

**✅ 완화(구현·검증됨) — same-tool native 보존**: normalized 병목을 *우회*.
- extract가 원본 세션 라인을 `NormalizedContext.raw`로 보존.
- **codex→codex**: native 라인을 그대로 replay(새 session_meta만 교체)
  → reasoning·turn_context·runtime event 보존.
- **claude→claude**: native 라인을 그대로 replay(sessionId/cwd만 재작성, `message`·uuid·
  서명은 불변) → **signed thinking까지 byte-단위 보존**. 라이브로 `claude --resume`
  성공 확인(서명 거부 없음, 이전 대화 정상 회상). *단, Claude Code가 매 turn 과거
  thinking을 전부 재전송하는지는 미확정 — 파일 보존과 재개는 확인됨.*
- `.cbctx`도 `native[]` artifact로 영속화 → `<tool>→.cbctx→<tool>`이 backup/restore에
  근접. import 시 새 session id + receiver cwd, 해시 불일치 시 normalized 폴백.
- **교차 도구(claude↔codex)는 여전히 normalized**(native는 같은 도구만 이해) →
  cross-tool은 본질적 lossy 유지. native는 untrusted로 취급(fence·redact 적용).
- **주의**: native는 codex reasoning을 포함하므로 `.cbctx`의 "thinking 제거 봉인"
  보장이 *messages*에만 적용됨. `--redact`는 native 라인도 스크럽.
- **현재 방향성**: 이 경로는 보안/증명보다 **same-tool fidelity**를 우선하는
  experimental path다. 공개 Context Hub 단계에서는 native artifact hash를
  package-level hash/signature에 묶는 강한 provenance가 추가로 필요하다.

---

## 2. 이식 한계 — 변환해도 타겟에 같은 의미로 안 붙는 것

### 2.1 도구 이름 불일치 — 가장 치명적 (⚠️ 완화됨)
변환된 Codex rollout의 `function_call.name` 실측(수정 전):
```
Read:10, Bash:5, ToolSearch:1, Write:1, Glob:1,
mcp__plugin_oh-my-claudecode_x__ask_codex:3,
mcp__plugin_oh-my-claudecode_x__check_job_status:1,
mcp__plugin_oh-my-claudecode_x__wait_for_job:1
```
이 이름들은 **Claude Code/MCP 고유**다. Codex의 실제 도구는
`shell_command`, `apply_patch` 등. 즉 resume한 Codex는 **자기가 가지지 않은
도구를 호출한 이력**을 보게 된다.

Codex 자가진단(gpt-5.5)이 직접 지적한 결과:
- 과거 `Read`/`Edit`/`Bash` 이력을 보고 **현재 그 도구를 쓸 수 있다고
  오인**하거나 과거에 한 행동을 잘못 추정할 수 있음(model bias).
- MCP 도구 결과(`Task`, 브라우저, GitHub, DB 등)는 자격증명·라이브 상태에
  의존 → Codex가 재현 불가. "증거(evidence)"로만 봐야 하는데 실행 가능한
  capability로 오인될 위험.

**완화(구현됨)** — Codex가 자기 도구로 오인하는 걸 두 겹으로 차단:
1. **Foreign tool 마킹**: 비-Codex 소스의 도구 이름을 `foreign_tool:<source>:<name>`
   으로 접두(예: `foreign_tool:claude-code:Read`). 네이티브 `function_call`처럼
   보이지 않게 함. extract 시 접두 제거 → round-trip 무손실·재주입 idempotent.
   라이브 실측: 변환된 rollout의 모든 도구명이 마킹됨(`Read/Bash/Edit/mcp__*`).
2. **Preamble 강화** (`buildBaseInstructions`): "도구 호출은 과거 증거다 / 소스
   도구명은 지금 없으니 의도를 네 도구로 매핑하라 / 편집 전 파일·git 상태 재검증
   하라"를 명시. 회귀 테스트 2개 추가(마킹·미마킹).

**남는 한계(원리적)**: 마킹·preamble은 *오인 방지*일 뿐, 과거 호출을 **재실행
가능하게** 만들진 못한다. `shell_command`↔`Bash` 같은 의미 매핑은 미구현이며,
`TodoWrite`·`Task`·MCP는 대응물 자체가 없음.

### 2.2 짝 없는 도구 호출 (dangling call) — ✅ 해결됨
**증상(수정 전)**: function_call 23 vs function_call_output 17 → 6 dangling.
원인: 세션을 작업 도중(in-flight) 추출하면 마지막 tool_use들의 결과가 아직
기록 전. OpenAI Responses 포맷은 모든 `function_call`에 output을 기대 →
dangling은 엄격한 타겟에서 거부/오연결 가능, 인과 단절.

**수정**: `buildCodexJsonl`이 전체 대화의 tool_result id 집합을 미리 계산하고,
매칭 output이 없는 tool_use 직후에 합성 placeholder output(
`[can-bridge: no tool output was recorded …]`)을 삽입. 실측 재검증:
**dangling 6 → 0** (synthetic 6개). 회귀 테스트 추가:
"CodexAdapter inject repairs a dangling tool_use".

> 잔여: 합성 output은 *원래 결과가 아니라 자리표시자*다. "이 호출이 무엇을
> 반환했는지"라는 정보 자체는 소스에 없으므로 복구 불가(§3 인접). 포맷
> 유효성과 인과 연결은 회복했지만 내용은 못 채운다.

### 2.3 블록 순서·인과 붕괴 — ✅ 해결됨
**증상(수정 전)**: `messageToResponseItems()`가 한 메시지를 text 전부 →
tool_use 전부 → tool_result 전부로 평탄화 → `[text→호출→text]` 인터리브가
`[text+text→호출]`로 뭉개짐.

**수정**: 블록을 원본 순서대로 순회하며 연속 text만 버퍼링하고
tool_use/tool_result 경계에서 flush하도록 재작성. 회귀 테스트 추가:
"CodexAdapter inject preserves interleaved text/tool block order".

### 2.4 call_id / 식별자 변질 — ⚠️ 부분 해결
- ✅ **빈 call_id 제거**: `tool_result`에 `toolUseId`가 없을 때 `call_id:""`를
  방출하던 문제 → 합성 id 생성으로 변경(실측 빈 call_id 0). 회귀 테스트로 보증.
- ❌ **출처 접두사**: call_id가 Anthropic `toolu_…` 접두사 그대로 → Codex
  네이티브 `call_…` 아님. 보통 무해(페어링만 일치하면 됨)하나 비네이티브.
  굳이 재작성할 실익이 적어 보류.

### 2.5 `[error]` 접두사 인코딩의 모호성 (기지 결함)
Anthropic `is_error:true`를 Codex엔 필드가 없어 output 앞에 `[error] `
문자열로 인코딩. 실제 도구 출력이 우연히 `[error] `로 시작 + `isError:false`
이면 round-trip에서 오분류(아키텍트 기록된 caveat).

### 2.6 역방향(Codex→Claude)의 role 붕괴
Codex `developer` role(권한·협업모드 preamble)은 normalized `system`으로
접힌 뒤 Claude inject에서 다시 처리 → 운영적 의미(지시 우선순위)가 1:1로
보존되지 않음.

### 2.7 과거 파일 편집은 재현되지 않는다 (stale state) — ⚠️ 완화됨
과거 Claude `Edit` 결과가 "파일 바꿈"이라 해도 Codex는 디스크를 직접 봐야
한다. 그 사이 파일이 다르거나 없을 수 있다.

**완화(구현됨)** — repo state 검증:
- **extract**가 source `cwd`의 git 상태(branch·short commit·dirty)를 best-effort로
  캡처(`src/util/git.ts`, 비-git/타임아웃 시 graceful null) → `source.git`.
- **codex inject**가 base_instructions에 "Source workspace / Source git state at
  capture" 스냅샷을 넣어 resumed agent가 출처 상태를 인지.
- inject 시 **현재 타겟 cwd의 git과 비교**해 commit/branch가 다르면 hint에
  `⚠️ Workspace moved since capture …` 경고 + `details.gitMismatch` 노출.
- 회귀 테스트 2개(불일치 로직·스냅샷). 라이브: `main @ 5f4c76a (dirty)` 캡처 확인.

**남는 한계**: 상태 *전이*가 아니라 *불일치 알림*일 뿐. 파일 내용 자체는 안 옮김.
TodoWrite 계획 상태도 여전히 과거 이력으로만 남음(미구현).

---

## 3. 근본 한계 — 포맷을 완벽히 맞춰도 불가능

- **모델 내부 상태(KV 캐시·숨은 추론 상태)는 전이 불가.** 같은 transcript를 줘도
  gpt와 claude는 같은 "이해"를 갖지 않는다. 즉 transcript를 완벽히 옮겨도
  행동 동등성(behavioral equivalence)은 **원리적으로 보장 불가** — 이건
  포맷 충실도와 별개의 벽이다. 다만 세션 파일에 명시적으로 기록된 Codex
  `reasoning` item은 같은 도구 native replay에서 보존 가능하며, 여기서 말하는
  한계는 파일 밖의 hidden/runtime state다.
- **프롬프트 캐싱/추론 효율**: 네이티브 세션의 캐시 이점은 주입 세션에서 재현 안 됨.
- **컨텍스트 윈도우 압박**: fidelity-first 기본값은 긴 tool output/native replay를
  크게 보존하므로 타겟 context limit을 빨리 밀어낼 수 있음. 완화 옵션으로
  `.cbctx` `--context-mode slim`, `--no-native`, `--since-compact`,
  `--max-tool-output-chars`를 둔다. 단 이는 보존율을 낮추는 선택이다.
- **프롬프트 인젝션 표면**: 주입 컨텍스트는 공격 표면. fence로 방어하지만
  fence 자체가 토큰·주의력을 먹고, 모델이 과거 명령형 텍스트를 지시로 오인할
  잔여 위험.

---

## 4. 실증 요약 (이번 세션에서 측정)

| 항목 | 측정값 |
|---|---|
| 소스 라인 → 메시지 라인 | 181 → 60 (33%) |
| 정규화 최종 메시지 | 26 |
| 버려진 라인 타입 종류 | 11+ (attachment, hook_*, tools_changed, …) |
| 버려진 바이트 최대 기여 | `attachment`(hook) **194KB** (대부분 노이즈) |
| Codex 출력 thinking 블록 | 0 (소스 8 → 전량 drop) |
| function_call vs output | 수정 전 23 vs 17 → dangling 6 / **수정 후 0** |
| 빈 call_id | **0** (수정됨) |
| 타겟에 없는 도구 이름 | Read/Bash/Glob/Write/ToolSearch/mcp__* 전부 |
| call_id 포맷 | `toolu_…` (Anthropic, 비네이티브, 보류) |

---

## 4.5 정리 — 고친 것 vs 그래도 안 되는 것

### ✅ 고친 것 (이번 작업, 코드+회귀 테스트)
| # | 한계 | 수정 | 검증 |
|---|---|---|---|
| 2.1 | 도구 이름 불일치(오인) | foreign 마킹(`foreign_tool:src:name`)+preamble 강화 | 라이브 전건 마킹, 테스트 2개 |
| 2.2 | dangling 도구 호출 | 매칭 없는 call에 합성 output 삽입 | dangling 6→0, 테스트 추가 |
| 2.3 | 블록 순서 평탄화 | 원본 순서 보존 재작성 | 순서 테스트 추가 |
| 2.4 | 빈 call_id | 합성 id 생성 | 빈 call_id 0, 테스트 |
| 2.7 | stale 상태(오인) | source git 캡처+preamble 스냅샷+불일치 경고 | 테스트 2개, 라이브 캡처 |

→ 전체 스위트 **48/48 통과**, 빌드 clean.

### ❌ 그래도 안 되는 것 (수정 후에도 남음)
**완화만 가능(B) — "transcript만 옮긴다"는 본질**
- **도구 이름 불일치(2.1)**: 마킹·preamble로 *오인*은 막았으나(완화됨), 과거
  호출을 재실행 가능하게는 못 만듦. 의미 매핑(`Bash↔shell_command`) 미구현,
  `TodoWrite/Task/MCP`는 대응물 없음.
- **합성 output의 내용**: dangling을 포맷상 복구했지만 *원래 무엇을 반환했는지*는
  소스에 없어 자리표시자뿐.
- **라인 67% 손실(1.1)**: 노이즈라 다 넣으면 오히려 악화. `hook_additional_context`
  같은 실입력만 선별 복구 가능(미구현).
- **숨은 컨텍스트(1.2)**: CLAUDE.md/AGENTS.md는 export 시 디스크에서 읽어 동봉
  가능(미구현). 시스템 프롬프트·MCP 목록은 기록만.
- **stale 상태(2.7)**: ✅ git 캡처+스냅샷+불일치 경고 구현됨. 단 상태 *전이*가
  아니라 *알림*이며, TodoWrite 계획 상태는 여전히 미구현.
- **`[error]` 모호성(2.5)**, **role 붕괴(2.6)**, **분기 소실(1.4)**: 완화 여지
  있으나 손실 0 불가.

**원리적으로 불가능(C) — 받아들이고 scope 밖 선언**
- **행동 동등성**: 다른 모델은 같은 transcript도 다르게 행동. 포맷 100% 맞춰도 벽.
- **모델 내부 실행 상태(KV cache·내부 reasoning state) 복구**: 세션 파일 밖이라 꺼낼 수 없음.
  (정정: *파일에 기록된* thinking/reasoning **텍스트**는 native replay로 보존된다 —
  Claude signed thinking은 byte 단위로 보존돼 `claude --resume`이 거부 없이 재개됨을
  라이브 확인. Codex `reasoning` item도 같은 Codex replay로 보존. 다만 이건 *기록된
  텍스트*의 보존이지 모델 내부 상태의 복제가 아니며, cross-tool에서는 여전히 폐기.)
- **이미 compaction된 소스의 원본**: 업스트림 소실.
- **프롬프트 캐싱 이점·인젝션 위험 0**: 재현/제거 불가.

---

## 5. Codex 자가진단 핵심 (gpt-5.5, target 관점)

- "이것은 **에이전트 정체성·라이브 도구·숨은 프롬프트·파일 스냅샷·실행
  상태가 아니라, 보이는 대화 증거만** 옮긴다"고 명시 문서화하라.
- 미가용 소스 도구는 **텍스트 이력으로 렌더링하거나 `foreign_tool_use:
  claude.Read`처럼 네임스페이스**하라. 일반 Codex `function_call`로 주입 금지.
- import preamble 추가: "이 도구 호출은 과거 이력이며 현재 Codex 도구와
  무관할 수 있다. 행동 전 파일·repo 상태를 검증하라."
- chain-of-thought drop은 유지해도 됨 — **보이는 transcript에 결론/근거가
  남아있는 한** 손실이 제일 작다. transcript에 결론이 없을 때만 치명적.
- 손실 심각도 순위(Codex 견해): **도구 출력/결정/파일 상태/지시 > 추론(thinking)**.

---

## 6. 미해결/추가 확인 필요

- [ ] Codex가 dangling function_call을 resume 시 실제로 거부하는지 라이브 검증
      (현재는 포맷 기대치에 근거한 추론).
- [ ] 미존재 도구명(`Read` 등)을 본 Codex가 실제로 그 도구를 호출 시도하는지
      vs 무시하는지 라이브 fixture로 관찰.
- [ ] `turn_context`/`token_count`/native developer preamble 누락이 모델·추론
      effort 선택에 영향 주는지 native vs imported 비교.
- [ ] 긴 세션에서 Claude `summary` 라인 타입 출현 여부.
