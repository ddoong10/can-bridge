# Tech Debt / 현재 상태의 엔지니어링 문제

> `docs/LIMITATIONS.md`(= 컨텍스트 *이전*의 원리적 한계)와 **다른 문서**다.
> 이건 코어 아이디어가 아니라 **현재 레포·코드·프로세스의 상태 문제** —
> 고치면 사라지는 것들. 심각도 P0(지금 위험) → P2(유지보수)로 정렬.
> 조사 기준일: 2026-06-03 (실측).

---

## P0 — 지금 당장 위험

### P0-1. 테스트가 사용자의 *실제* 세션 저장소에 쓴다 (비격리) — ✅ 해결됨
**수정**: 어댑터·doctor가 홈 경로를 **호출 시점에 env에서 해석**하도록 변경
(`CB_CLAUDE_HOME`/`CB_CODEX_HOME`, 미설정 시 `~/.claude`·`~/.codex`). 테스트는
시작 시 `mkdtemp`로 임시 홈을 만들어 두 env에 주입하고 종료 시 제거 → 모든
inject가 temp에만 씀. 실제 홈에 픽스처를 쓰던 "ambiguous id" 테스트도 temp로
이전. **44/44 통과**. (읽기 전용 헬퍼 2곳은 실데이터 있으면 파싱 검증, 없으면
skip — 오염 아님.)

<details><summary>원래 문제(기록 보존)</summary>
- `tests/smoke.test.mjs`의 inject 계열 테스트(7곳: L156/414/559/618/660/706/1261)가
  `adapter.inject()`를 호출 → **실제 `~/.codex/sessions/...` 와 `~/.claude/projects/...`
  에 파일을 씀**. 정리는 `fs.unlink(result.locator)`에 의존하므로 **테스트가
  중간에 실패하면 사용자 실세션 폴더에 잔여 파일이 남는다**.
- 일부 테스트는 사용자의 로컬 세션이 *존재해야* 통과(없으면 skip) → **비결정적·
  비-hermetic**. (`HANDOFF.md`의 sandbox EPERM 실패가 바로 이 증상.)
- **영향**: 사용자 데이터 오염, 로컬/sandbox에서 빨간 실패, CI와 로컬 결과 불일치.
- **수정**: inject 대상 루트를 env(`CB_CLAUDE_HOME`/`CB_CODEX_HOME`)로 주입 가능하게
  하고 테스트는 `mkdtemp`로 격리. 실데이터 의존 read 테스트는 합성 fixture로 대체.
</details>

### P0-2. `*.cbctx`가 .gitignore에 없고 2.7MB 덤프가 루트에 방치됨 — ✅ 해결됨
(커밋 `c029809`: `.gitignore`에 `*.cbctx` 추가 + `handoff.cbctx` 제거.)

- `handoff.cbctx`(**2.68 MB**)가 working tree 루트에 untracked로 존재.
- `.gitignore`에 `*.cbctx` **없음** → `git add .` 한 번이면 커밋됨.
- `.cbctx`는 **전체 컨텍스트 + dirty patch 덤프**다. redaction은 opt-in(기본 off)
  이므로 **비밀키·내부코드가 그대로 들어있을 수 있다**. 공개 레포라 더 위험.
- **수정(1줄)**: `.gitignore`에 `*.cbctx` 추가 + `handoff.cbctx` 제거/이동.
  공유 플로우는 redaction 기본 on 검토(OPEN_QUESTIONS의 프라이버시 항목).

---

## P1 — 제품 방향(VISION)에 곧 직접 걸림

### P1-1. 요약/압축기 부재 — 긴 컨텍스트를 통째로 덤프
- `src/transform/`에 `fence.ts`, `redactor.ts`만 있고 **summarizer 없음**.
- inject는 전체 메시지를 그대로 씀 → **타겟 컨텍스트 윈도우 초과/희석** 가능.
- **VISION의 "긴 단일 대화가 표준이 된다" 논지와 정면 충돌**: 정작 길어지면
  지금 구조가 못 버틴다. 압축·선별 주입이 코어 기능이 돼야 함.

### P1-2. 변조 방지/서명 부재 — provenance가 약하다
- 무결성은 `.cbctx`의 `contentHash`뿐. `.cbctx`는 **편집 가능한 평문 JSON**.
- VISION의 provenance·면접 평가 use case는 **암호학적 서명/증명**(누가·언제·
  무엇을, 위변조 불가)이 전제인데 현재 없음. 해시는 "내용 일치" 확인일 뿐
  "출처 진위" 보장이 아님.
- Same-tool fidelity를 위해 추가된 `native[]` artifact는 현재 보존율 우선 경로다.
  각 artifact는 자체 hash를 갖지만, 공개 허브/평가 용도로 쓰려면 native
  artifact hash를 package-level hash에 anchor하고 서명까지 연결해야 한다.
  지금 발표 범위에서는 "정확한 복원 성능"을 우선하고, 강한 provenance hardening은
  후속 과제로 둔다.

### P1-3. dist를 git에 커밋 → src/dist 드리프트
- `dist/` 51개 파일이 tracked(원래는 GitHub 설치 시 tsc 불필요하게 하려는 의도).
- 빌드가 src와 일치한다는 **보장 가드 없음** → 실제로 이번에 `dist/eval/run.js`가
  src와 **stale** 상태로 발견됨(커밋에 함께 정리됨).
- **수정**: CI에 "build 후 `git diff --exit-code dist/`"로 드리프트 차단, 또는
  dist를 릴리스 산출물로만 두고 추적 해제.

---

## P2 — 유지보수 / 확장성

### P2-1. doctor는 휴리스틱 마커 검사지 진짜 스키마 검증이 아님
- `session-doctor.ts`는 알려진 마커 존재 여부로 점수를 매김. 미지의 포맷 변화는
  통과할 수 있음. (`pipe`에 `--skip-doctor`로 연결은 됨 — 그 OPEN_QUESTION은 해소.)

### P2-2. 모놀리식 파일 비대
- `cli/index.ts` **786줄**, `codex.ts` 735줄, `claude-code.ts` 612줄. 서브커맨드·
  어댑터가 한 파일에 누적 → 신규 어댑터/명령 추가 시 마찰.

### P2-3. 어댑터 2개뿐
- `claude-code`, `codex`만. Cursor/ChatGPT export/Gemini는 미구현(알려진 v1+).
  VISION의 "허브"가 되려면 소스 다양성이 핵심인데 현재 2종.

### P2-4. node:sqlite 실험 플래그 의존
- Codex TUI 자동 등록은 `node:sqlite`에 의존, Node 22.x는 `--experimental-sqlite`
  필요 → 미설정 시 silently degrade(문서화는 됨). CI(node 22.x)에서 이 경로 미검증.

### P2-5. tier-B 한계 완화 미구현 (LIMITATIONS에서 이월)
- foreign-tool 네임스페이싱(2.1), `hook_additional_context` 선별 복구(1.1),
  CLAUDE.md/AGENTS.md 동봉(1.2), cwd/branch/commit 캡처+불일치 경고(2.7).

---

## 잘 되어 있는 것 (균형)
- **런타임 의존성 0** (devDeps만 typescript/@types/node) — 공급망 위험 최소.
- **CI 존재**: `.github/workflows/ci.yml` — ubuntu+windows, node 22.x로
  build+test 매트릭스.
- **회귀 테스트 문화**: 어댑터 변경 시 smoke 테스트 동반(현재 44/44).
- doctor가 `pipe` 프리플라이트로 연결됨(`--skip-doctor` опт아웃).

---

## 우선순위 제안
1. **P0-2(.gitignore `*.cbctx`)** — 1줄, 즉시. 유출 위험 차단.
2. **P0-1(테스트 격리)** — 사용자 데이터 오염 방지 + CI/로컬 일치.
3. **P1-1(요약기)** / **P1-2(서명)** — VISION을 진지하게 가면 코어 기능.
4. 나머지 P1-3/P2 — 릴리스 전 정리.
