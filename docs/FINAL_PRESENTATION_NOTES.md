# Final Presentation Notes — can-bridge

> 최종발표용 노트. 기존 `docs/PRESENTATION_NOTES.md`는 중간발표 기록으로
> 보존한다. 이 문서는 **중간발표 이후 무엇이 바뀌었고, 아직 무엇이 한계인지,
> 그래서 어떤 방향으로 갈 수 있는지**에 집중한다.
>
> 평가 지표/behavior eval 파트는 다른 발표자가 담당하므로 여기서는 깊게 다루지
> 않는다.

---

## 발표 목표

최종발표에서 전달할 메시지:

> 중간발표 때는 "Claude Code와 Codex 사이에 컨텍스트를 옮길 수 있다"를
> 보였다. 이후에는 단순 변환기를 넘어서, 컨텍스트를 더 정확하게 보존하고,
> 공유하고, 한계를 명확히 규정하는 방향으로 발전시켰다.

한 줄:

> can-bridge는 agent clone이 아니라, AI 작업 컨텍스트의 이식 가능한
> provenance layer다.

---

## 1. 중간발표 때 상태

### 당시 보여준 것

- Claude Code와 Codex CLI의 로컬 세션 포맷을 reverse engineering.
- Claude Code 세션 JSONL을 Codex rollout JSONL로 변환.
- Codex에서 `resume`해서 이전 Claude Code 컨텍스트를 읽는 것 확인.
- 기본적인 `NormalizedContext` 구조 제안.

### 당시 핵심 메시지

```text
서로 다른 AI 코딩 도구의 대화 컨텍스트를 옮길 수 있다.
```

### 당시 한계

- 거의 Claude → Codex 중심.
- tool call 구조 보존이 제한적.
- 같은 도구로 되돌아가도 normalized schema를 지나며 손실.
- 공유 패키지/무결성/보안/검증은 약함.
- 한계가 정리되어 있지 않아 "얼마나 정확히 이어지는가"를 설명하기 어려움.

---

## 2. 최종발표에서 보여줄 변화

### 요약 표

| 영역 | 중간발표 | 현재 |
|---|---|---|
| 방향 | Claude → Codex 변환 | Claude Code ⇄ Codex 양방향 context handoff |
| 포맷 | 기본 NormalizedContext | NormalizedContext + `.cbctx` + native artifact |
| 도구 호출 | 일부 변환 | tool_use/tool_result ⇄ function_call/function_call_output |
| 검증 | 수동 확인 | doctor, hash, smoke tests |
| 공유 | 같은 머신 중심 | `.cbctx`로 다른 사람/환경에 전달 |
| same-tool 보존 | normalized 병목으로 손실 | Codex native rollout replay |
| 한계 분석 | 산발적 | `docs/LIMITATIONS.md`로 정리 |
| 비전 | 변환기 | Context Hub / provenance layer |

### 말할 문장

> 중간발표 이후 가장 큰 변화는 "된다"에서 끝난 게 아니라, 어떤 정보가
> 보존되고 어떤 정보는 원리적으로 보존되지 않는지까지 분해했다는 점입니다.

---

## 3. 현재 아키텍처

### 기본 경로: cross-tool

```text
Claude Code session
    ↓ extract
NormalizedContext
    ↓ inject
Codex rollout
```

또는 반대:

```text
Codex rollout
    ↓ extract
NormalizedContext
    ↓ inject
Claude Code session
```

### 공유 경로

```text
Source session
    ↓ extract
NormalizedContext + metadata
    ↓ package
.cbctx
    ↓ import
Target session
```

### same-tool fidelity 경로

```text
Codex rollout
    ↓ extract
NormalizedContext + raw Codex rollout
    ↓ .cbctx
Codex import
    ↓ native replay
New Codex rollout
```

### 핵심 구분

```text
NormalizedContext = cross-tool compatibility
native artifact   = same-tool fidelity
.cbctx            = portable context package
```

---

## 4. 개선 1 — 양방향 변환과 tool call 보존

### 문제

AI 코딩 대화는 텍스트만 있는 게 아니다.

```text
assistant: 파일 읽어볼게요
tool_use: Read src/index.ts
tool_result: 파일 내용
assistant: 여기 문제가 있습니다
```

Markdown으로 넘기면 이 구조가 흐려진다.

### 현재 처리

| Claude/Anthropic style | Codex/OpenAI Responses style |
|---|---|
| `tool_use { id, name, input }` | `function_call { call_id, name, arguments }` |
| `tool_result { toolUseId, output, isError }` | `function_call_output { call_id, output }` |

추가로 처리한 것:

- text/tool block 순서 보존.
- dangling tool call에 synthetic output 삽입.
- 빈 `call_id` 제거.
- `[error] ` prefix로 error state round-trip.

### 발표 포인트

> 단순히 transcript를 붙여넣는 게 아니라, agent가 실제로 어떤 도구를 호출했고
> 어떤 결과를 받았는지까지 구조화해서 옮깁니다.

---

## 5. 개선 2 — foreign tool history 오인 방지

### 문제

Claude Code의 tool 이름:

```text
Read, Edit, Bash, Glob, Task, mcp__...
```

Codex의 tool 이름:

```text
shell_command, apply_patch, ...
```

그런데 Claude의 `Read` 이력을 Codex `function_call`처럼 넣으면 Codex가
"내가 Read라는 tool을 쓸 수 있나?"라고 오해할 수 있다.

### 해결

비-Codex source에서 온 tool 이름을 Codex에 넣을 때:

```text
Read
→ foreign_tool:claude-code:Read
```

그리고 base instructions에 명시:

```text
이 tool call은 과거 source tool의 증거다.
현재 Codex에서 호출 가능한 tool이 아니다.
파일과 git 상태는 다시 확인해라.
```

### 발표 포인트

> 구조를 보존하는 것만큼 중요한 게, target agent가 그 구조를 잘못 해석하지
> 않게 하는 것입니다.

---

## 6. 개선 3 — repo state verification

### 문제

컨텍스트는 코드 상태와 붙어 있다.

```text
대화 속에서는 src/parser.ts를 고쳤다고 되어 있음
하지만 받는 사람 repo는 다른 commit일 수 있음
```

이 경우 agent는 과거 tool output을 현재 파일 상태로 착각할 수 있다.

### 해결

extract 시:

```text
branch
commit
dirty 여부
```

를 best-effort로 캡처.

inject/import 시:

- source git state를 base instructions에 기록.
- 현재 workspace와 다르면 CLI hint와 agent preamble에 경고.

### 발표 포인트

> 우리는 파일 자체를 완전히 복제하는 것이 아니라 transcript를 옮깁니다.
> 그래서 repo 상태 차이를 숨기지 않고, agent와 사용자 모두에게 보여주는 방향을
> 선택했습니다.

---

## 7. 개선 4 — `.cbctx` 공유 패키지

### 문제

`pipe`는 같은 머신에서 이어가기에는 좋지만, 다른 사람에게 넘기려면 부족하다.

### 해결

`.cbctx` 패키지:

- source tool/model/session/cwd
- normalized messages
- optional repo metadata / dirty patch
- redaction metadata
- doctor snapshot
- contentHash
- optional native artifact

### 사용 예시

```powershell
can-bridge share --from codex --latest --redact --include-repo-ref --include-patch --out handoff.cbctx
can-bridge import --to codex --in handoff.cbctx
```

### 발표 포인트

> 이제 컨텍스트를 단순히 내 로컬에서 옮기는 것을 넘어, 하나의 artifact로
> 포장해서 다른 사람에게 전달할 수 있습니다.

---

## 8. 개선 5 — same-tool native preservation

### 기존 문제

같은 Codex로 돌아가는 경우에도 예전에는:

```text
Codex rollout → NormalizedContext → Codex rollout
```

이 경로를 탔다.

그러면 Codex native 정보가 손실됨:

- `reasoning`
- `turn_context`
- `event_msg`
- token/runtime metadata

### 현재 해결

Codex에서 추출할 때 raw rollout lines도 같이 보존:

```text
NormalizedContext.raw
.cbctx native[]
```

Codex로 다시 import할 때:

- 원본 `session_meta`만 제거.
- 새 session id / receiver cwd / can-bridge fence를 담은 session_meta 생성.
- 나머지 native Codex lines는 최대한 그대로 보존.

### 중요한 경계

```text
Codex → Codex: native artifact replay
Codex → Claude: native artifact 무시, NormalizedContext 사용
```

### 발표 포인트

> cross-tool에서는 호환성이 중요하고, same-tool에서는 보존율이 중요합니다.
> 그래서 두 경로를 분리했습니다.

---

## 9. 현재 한계 정리

`docs/LIMITATIONS.md`에 정리한 핵심:

> can-bridge는 session migration이 아니라 context import다.

### 완화 가능한 한계

- foreign tool 오인 → marker/preamble으로 완화.
- repo mismatch → git snapshot/warning으로 완화.
- same-tool 손실 → native artifact replay로 완화.
- 긴 context 비용 → summarization/trimming 필요.
- context file 누락 → `CLAUDE.md`, `AGENTS.md` 동봉 가능.
- provenance 신뢰성 → signature/hash anchoring 필요.

### 원리적으로 어려운 한계

- KV cache 복제.
- vendor hidden system prompt 복제.
- 모델 내부 reasoning state 복제.
- 이미 compaction된 원본 대화 복구.
- 다른 모델이 같은 transcript에서 완전히 같은 행동을 하게 보장.

### "거의 다 복원된다"를 어떻게 말할 것인가

이 부분은 발표에서 가장 오해가 생기기 쉽다.

Codex의 `reasoning`에는 두 층이 있다.

1. **세션 파일에 기록된 native reasoning artifact**
   - Codex rollout JSONL에 `reasoning`, `turn_context`, `event_msg`처럼 남는 기록.
   - 같은 Codex로 돌아갈 때는 `native[]` replay로 상당 부분 보존 가능.
   - can-bridge가 이번에 보존율을 크게 끌어올린 부분.

2. **모델 실행 중 내부 상태**
   - KV cache, attention state, vendor hidden prompt, 모델 내부 scratchpad.
   - 세션 파일에 export 가능한 형태로 존재하지 않음.
   - `/resume`도 이 상태를 되살리는 게 아니라, 저장된 transcript와 세션 기록을
     다시 context로 넣어 이어가는 방식에 가깝다.

따라서 정확한 표현:

```text
완전한 agent identity 복제는 아니다.
하지만 코딩 작업을 실제로 이어가는 데 필요한 practical continuity는
상당히 높게 복원할 수 있다.
```

발표 멘트:

> 내부 사고 상태를 그대로 복사하는 것은 불가능하지만, 코딩 협업에서 중요한
> 요청, 결정, 도구 호출, 도구 결과, 파일 상태, 그리고 같은 Codex의 native
> session artifact는 대부분 관찰 가능한 기록으로 남습니다. can-bridge는 이
> 관찰 가능한 기록을 최대한 구조화해서 다음 에이전트가 실제 작업을 이어갈 수
> 있게 만드는 시스템입니다.

### 말할 문장

> 이 한계는 실패가 아니라 제품 경계입니다. 우리는 agent를 복제하려는 것이
> 아니라, 외부에서 관찰 가능한 AI 협업 기록을 최대한 충실하게 옮기는 것입니다.

---

## 10. 관련 오픈소스와 연결 가능성

OpenClaw / Hermes:

- 여러 agent를 실행하고 조율하는 orchestration layer.
- session, memory, task, kanban, subagent 운영이 핵심.

can-bridge:

- live agent router가 아니라 context interchange layer.
- 이들의 MCP/tool/plugin으로 붙을 수 있음.

### 말할 문장

> OpenClaw나 Hermes가 여러 agent를 운영하는 프레임워크라면, can-bridge는
> 그 agent들이 주고받을 수 있는 context artifact를 표준화하는 하위 계층입니다.

---

## 11. 최종 비전 — Context Hub

### 핵심 reframe

```text
reproduction이 아니라 provenance
```

Hugging Face 비유를 그대로 가져오면 위험하다:

- 모델은 self-contained artifact에 가깝다.
- context는 모델, 도구, repo 상태, runtime에 따라 행동이 달라진다.

그래서 정확한 비전:

> Hugging Face for AI work contexts, focused on provenance rather than
> deterministic reproduction.

### 발표 마무리 문장

> 중간발표에서는 서로 다른 도구 사이에서 컨텍스트가 이동할 수 있음을 보였습니다.
> 최종적으로는 그 컨텍스트를 더 정확하게 보존하고, 공유하고, 한계를 명확히
> 규정하는 방향으로 발전시켰습니다. 장기적으로는 코드 결과물뿐 아니라
> "AI와 함께 어떻게 만들었는가"라는 작업 과정을 표준 포맷으로 남기는
> Context Hub로 확장할 수 있다고 봅니다.

면접/평가 use case는 보조 예시:

> 프로젝트 제출이나 AI-native 채용에서 결과물뿐 아니라 AI 활용 과정 자체를
> 보는 자료가 될 수 있습니다. 단, 동의, privacy, signature가 전제입니다.

---

## 추천 슬라이드 구성

1. Title: can-bridge
2. Midterm recap: what we showed before
3. Problem after midterm: "works" is not enough; fidelity matters
4. Current architecture: NormalizedContext + `.cbctx` + native artifact
5. Improvement 1: bidirectional + tool-call aware conversion
6. Improvement 2: foreign tool marking
7. Improvement 3: repo-state verification
8. Improvement 4: `.cbctx` sharing
9. Improvement 5: same-tool native preservation
10. Limitations: context import, not agent clone
11. Open-source positioning: OpenClaw/Hermes integration
12. Vision: Context Hub / provenance

---

## Q&A 대비

| 질문 | 답 |
|---|---|
| 중간발표 이후 제일 크게 바뀐 점은? | 양방향 변환, tool-call 보존, `.cbctx` 공유, repo-state 검증, same-tool native preservation까지 들어가면서 단순 변환기에서 context package 기반으로 발전했다. |
| Markdown으로 넘기는 것과 뭐가 다른가? | Markdown은 사람이 읽는 요약이고, can-bridge는 role, tool call, tool result, source metadata, repo state를 보존하는 구조화 artifact다. |
| 같은 도구로 되돌아갈 때도 손실되나? | 예전에는 normalized 병목 때문에 손실됐다. 지금은 Codex→Codex는 native rollout artifact를 replay해서 reasoning/turn_context/event_msg까지 보존한다. |
| 다른 도구로 갈 때 native artifact도 쓰나? | 아니다. Codex native artifact는 Codex만 이해한다. Claude로 import할 때는 normalized messages만 사용한다. |
| `/resume`과 완전히 같은가? | 아니다. `/resume`도 저장된 session log를 다시 읽는 방식에 가깝고, KV cache나 hidden state를 복제하는 것은 아니다. can-bridge는 그 session log를 다른 도구/환경에서도 읽을 수 있게 옮긴다. |
| 절대 해결 못 하는 한계는? | hidden system prompt, KV cache, 모델 내부 reasoning state, 이미 compaction된 원본, 다른 모델의 완전한 행동 동등성은 외부 도구가 보장하기 어렵다. |
| OpenClaw/Hermes와 경쟁하나? | 아니다. 그들은 multi-agent orchestration이고, can-bridge는 context artifact/interchange layer다. MCP나 adapter로 붙는 쪽이 자연스럽다. |
| 보안은 충분한가? | redaction, hash, untrusted fence는 있다. 다만 public Context Hub나 면접 평가까지 가려면 signature, access control, stronger provenance가 필요하다. |
