# 발표 자료 — can-bridge (모델·핵심·발전·한계·오픈소스)

> 최종발표용 정리 문서. 슬라이드가 아니라 **말할 내용의 근거 자료**.
> 평가(metric)는 동료 담당이라 여기서 다루지 않음. 5개 축:
> ① 모델 설명 ② 중요 포인트 ③ 어떻게 발전시켰나 ④ 한계점 ⑤ 오픈소스 연관성.
> 상세는 `LIMITATIONS.md` / `VISION.md` / `RELATED_PROJECTS.md` 참조.

---

## ① 모델 설명 — can-bridge가 무엇인가

**한 줄**: 한 LLM 코딩 에이전트의 대화 컨텍스트를 추출 → 공통 포맷으로 정규화 →
다른(또는 같은) 에이전트에 주입해서, **모델·도구를 갈아타도 대화를 이어가게** 하는 CLI.

### 3단계 파이프라인
```
Source tool (Claude Code / Codex)
      │  extract()
      ▼
NormalizedContext   ← 공통 교환 포맷 (lingua franca)
      │  inject()
      ▼
Target tool (Codex / Claude Code) → 사용자가 resume
```

- **어댑터 인터페이스 2개**: `SourceAdapter.extract()`, `TargetAdapter.inject()`.
- **한 도구 = 한 어댑터 파일**이 Source·Target 둘 다 구현 → 새 도구 추가 = 파일 하나.
- **NormalizedContext**: Anthropic 스타일 블록(`text` / `thinking` / `tool_use` /
  `tool_result`)을 표준형으로. 도구 호출은 어댑터 경계에서 변환
  (`tool_use/tool_result` ↔ Codex `function_call/function_call_output`).

### 세션이 저장되는 곳 (우리가 읽고 쓰는 대상)
| 도구 | 로컬 파일 |
|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `state_5.sqlite`(인덱스) |

### 2층 구조 (이번에 추가된 핵심 설계)
- **Cross-tool(다른 도구)**: NormalizedContext 경유 → 호환되지만 **lossy**.
- **Same-tool(같은 도구)**: 원본 native 세션 라인을 **그대로 보존**(`raw`)해서
  재생(replay) → **near-lossless 복원**. `.cbctx` 패키지에도 `native[]`로 영속화.
- 즉 **NormalizedContext = 교환 포맷, native artifact = 같은 도구 백업/복원 포맷**.

---

## ② 중요 포인트 — 발표에서 꼭 짚을 것

1. **비공식 포맷을 직접 reverse-engineer 했다.**
   Claude Code·Codex 세션 포맷은 **공식 문서가 없고 버전마다 바뀐다.** 실제 파일을
   까서 라인 구조를 확인하고 `OPEN_QUESTIONS.md`에 기록 → 다른 사람에게 reference.

2. **양방향 + 도구 호출까지, 실제 머신에서 검증.**
   Claude→Codex: gpt가 원래 한국어 첫 메시지를 **글자 단위로 회상**.
   Codex→Claude: 158메시지 세션이 `claude --resume` 피커에 정상 등록·재개.

3. **작은 함정들이 핵심 노하우.**
   - 폴더 인코딩: cwd의 `:`,`\`,`/`,**그리고 `_`까지** 모두 `-`로 치환(비명세).
   - "에러가 거짓말": Codex의 `thread not found`는 보조 테이블 동기화 실패일 뿐,
     메인 write-back은 정상 → **에러 메시지 말고 결과(파일 크기·tail)를 측정**.

4. **/resume의 정체 = "기억 복원"이 아니라 "회의록 다시 읽기".**
   `/resume`이 되는 이유는 대화가 **로컬 파일에 저장**돼 있어서다. 모델이 대기 중에도
   기억을 들고 있는 게 아니라, 매 turn 저장된 transcript를 context로 다시 넣는 것.
   → can-bridge가 가능한 이유이자, **한계의 근거**(아래 ④-C).

5. **same-tool native 보존으로 충실도를 끌어올림.**
   같은 Codex로 돌아갈 때는 normalized 병목을 우회해 reasoning·turn_context·
   runtime event까지 보존 → "변환"이 아니라 거의 "native backup/restore".

---

## ③ 어떻게 발전시켰나 — v0 → 현재

발전의 핵심은 **"동작 → 정직한 한계 분석 → 그 한계를 코드로 좁히기"** 사이클.
그리고 **Claude Code와 Codex가 레포 파일로 협업**해 구현→리뷰→수정을 돌림.

| 단계 | 내용 |
|---|---|
| v0 | Claude Code → Codex 단방향 변환·주입 |
| v0.1 | **양방향** 어댑터 + 도구 호출 schema 변환 + opt-in 시크릿 redactor |
| 분석 | 한계를 **추출/이식/근본(A·B·C)** 으로 구조화. **Codex에 직접 자문**해 타겟 관점 확보 |
| 수정 1 | 이식 결함 3개: **dangling 도구 호출**(6→0), **블록 순서 평탄화**, **빈 call_id** |
| 위생 | 테스트 **비격리 해결**(실제 홈 오염 차단), `*.cbctx` **유출 차단** |
| 보존 1 | **foreign tool 마킹**(`foreign_tool:claude-code:Read`)+preamble → Codex가 남의 도구를 자기 것으로 오인하는 문제 차단 |
| 보존 2 | **repo state 검증**: source git(branch·commit·dirty) 캡처 → 워크스페이스 이동 시 경고. *Codex가 diff 리뷰 → 5건 지적 → 전부 반영* |
| 보존 3 | **same-tool native 보존**: 원본 rollout을 `.cbctx` `native[]`로 영속화, 같은 도구로 near-lossless 복원. *Codex 스펙 작성 → Claude 구현 → Codex 리뷰* |

> 협업 포인트: 두 모델이 **숨은 컨텍스트가 아니라 repo 파일**(`HANDOFF.md`/`DECISIONS.md`)로
> 일을 주고받음 — can-bridge가 풀려는 문제(컨텍스트 공유)를 **개발 방식 자체로 시연**.

검증: 빌드 clean, smoke 테스트 **55/55 통과**(어댑터 변경마다 회귀 테스트 동반).

---

## ④ 한계점 — A/B/C (정직하게)

> 모든 한계의 뿌리: 이건 **session migration이 아니라 context import**다.
> 옮기는 건 *보이는 transcript*뿐, 모델 내부 상태가 아니다.

**A. 고친 것 (코드+테스트로 닫음)**
- 짝 없는 도구 호출(2.2), 블록 순서(2.3), 빈 call_id(2.4) → 수정.
- 도구 이름 오인(2.1) → foreign 마킹+preamble로 완화.
- stale 파일 상태(2.7) → git 스냅샷+불일치 경고로 완화.
- 테스트 비격리·`.cbctx` 유출 → 해결.

**B. 완화는 되나 손실 0은 불가능 ("transcript만 옮긴다"는 본질)**
- 도구 **의미 매핑**(`Bash↔shell_command`) 미구현, `TodoWrite/Task/MCP`는 대응물 없음.
- 추출 시 **소스 라인 67% 폐기**(대부분 hook/UI 노이즈라 다 넣으면 오히려 악화 —
  단 `hook_additional_context` 같은 실입력은 선별 복구 여지).
- 숨은 컨텍스트(시스템 프롬프트·CLAUDE.md·MCP 목록) 미전이.
- 긴 세션 **요약기 부재** → 통째 덤프(타겟 윈도우 압박).

**C. 원리적으로 불가능 (받아들이고 scope 밖 선언)**
- **모델 내부 상태(KV cache·reasoning state) 전이 불가** — 세션 파일에 *애초에 없음*.
  모델·tokenizer·런타임 종속이라 외부 도구가 꺼낼 수 없음.
- **행동 동등성**: 다른 모델은 같은 transcript도 다르게 행동.
- thinking/reasoning **재주입 불가**(서명 무효 — 같은 Claude끼리도).
- 이미 compaction된 소스의 원본 / 네이티브 프롬프트 캐싱 이점.

> 발표 멘트: "KV cache·reasoning state는 세션 파일에 존재하지 않고 모델·런타임에
> 종속됩니다. 그래서 우리는 internal state 복제를 **목표로 하지 않습니다.** 대신
> 관찰 가능한 대화·도구 호출·도구 결과·repo 상태를 최대한 충실히 옮깁니다."

---

## ⑤ 오픈소스와의 연관성

### (a) "오픈"의 토대 — 로컬 파일이라서 가능하다
Claude Code·Codex는 세션을 **사용자 로컬 파일**(`~/.claude`, `~/.codex`)에 남긴다.
서버에 갇힌 게 아니라 디스크에 있기 때문에 외부 도구가 읽고 변환할 수 있다.
(웹/앱 컨텍스트는 서버측 → 우리 도구로 못 뺌. 이게 로컬 CLI를 택한 이유.)
단, 포맷은 **비공식·비문서화** → 우리의 reverse-engineering 기록 자체가 공개 reference.

### (b) 선행 오픈소스 프로젝트 (정직한 포지셔닝)
이 공간엔 이미 활발한 프로젝트가 있다 — "최초"라고 주장하지 않는다.
- **가장 가까운 선행**: [`ai-session-bridge`](https://github.com/bakhtiersizhaev/ai-session-bridge)
  — Claude↔Codex JSONL 변환·도구 매핑. (단, 자기 README에 Claude→Codex resume은
  "아직 미검증"이라 명시 → **우리는 양방향 end-to-end 검증**으로 차별)
- **라이브 브릿지류**: `agent-bridge`, `codex-claude-bridge` — 실시간 MCP/데몬 연결.
- **MCP 래퍼류**: `codex-bridge-mcp`(읽기 전용), `codex-mcp-server`, `pal-mcp-server`.
- **워크플로/메모리류**: `ccb`(멀티 에이전트 터미널), `rex-cli`(ContextDB), `CoBridge`.

### (c) 우리의 차별점 — "loss-aware context interchange core"
라이브 브릿지가 아니라 **손실을 인지하는 컨텍스트 교환 코어**로 포지셔닝.
- 실제 로컬 세션 파일을 **추출 + 주입**(둘 다, 양방향).
- 한 도구를 subprocess로만 보지 않고 **공통 schema**로 정규화.
- **손실 경계를 명시**(LIMITATIONS) — 어디까지 옮기고 무엇을 못 옮기는지 문서화.
- **native 보존**으로 same-tool 충실도 ↑.
- 의존성 **0**(런타임) → MCP 서버·에디터 확장·데몬이 위에 얹기 쉬운 코어.

### (d) 자체도 오픈소스 + 재현 가능한 협업 패턴
- 레포는 공개(npm `can-bridge`, GitHub tarball 설치 가능).
- Claude Code와 Codex가 **레포 파일로 협업**한 과정(HANDOFF/DECISIONS) 자체가
  재현 가능한 멀티 에이전트 협업 사례.

> 발표 멘트: "이미 브릿지 프로젝트는 많습니다. 우리의 기여는 *최초의 다리*가 아니라,
> **무엇이 얼마나 손실되는지 아는 교환 코어** + **같은 도구로 돌아갈 땐 원본을 보존**하는
> 2층 설계입니다."

---

## 부록 — 30초 엘리베이터 피치
> "Claude Code에서 며칠 쌓은 컨텍스트를 Codex로, 또는 그 반대로 이어가고 싶을 때.
> 두 도구의 비공식 세션 포맷을 reverse-engineer 해서, 컨텍스트를 추출·정규화·주입하는
> 양방향 CLI를 만들었습니다. 다른 도구로 갈 땐 공통 포맷으로(손실 인지), 같은 도구로
> 돌아올 땐 원본 세션을 그대로 보존해서요. KV cache 같은 모델 내부 상태는 옮기지
> 못한다는 경계까지 정직하게 그었습니다."
