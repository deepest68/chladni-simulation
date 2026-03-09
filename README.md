# 클라드니 패턴 인터랙티브 시뮬레이션

> **Chladni Pattern Interactive Web Simulation**

[![Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=flat-square)](https://deepest68.github.io/chladni-simulation/)

---

## 클라드니 패턴이란?

**클라드니 패턴(Chladni Patterns)**은 1787년 독일 물리학자 Ernst Chladni가 발견한 현상입니다.  
금속 평판 위에 모래를 뿌리고 바이올린 활로 가장자리를 켜면, 모래가 진동의 **노드 라인(node lines)**—진동이 0인 선—으로 모여 아름다운 기하학적 패턴을 만듭니다.

진동 방정식(2D 정현파):
```
z = sin(m · π · x) · sin(n · π · y)
```
여기서 m, n 은 각 축의 진동 모드 번호입니다.

---

## 데모

🔗 **[https://deepest68.github.io/chladni-simulation/](https://deepest68.github.io/chladni-simulation/)**

---

## 기능

| 기능 | 설명 |
|------|------|
| 실시간 입자 시뮬레이션 | 수천 개의 모래 입자가 노드 라인으로 수렴 |
| X / Y 진동 모드 슬라이더 | m, n 모드(1–10) 실시간 조절 |
| 입자 수 조절 | 1,000 ~ 10,000개 |
| 진동 히트맵 | 배경에 진동 강도를 색상으로 표시 |
| 프리셋 패턴 | 유명한 클라드니 패턴 8가지 원클릭 선택 |
| PNG 저장 | 현재 캔버스를 이미지로 다운로드 |
| 호버 정보 | 마우스 위치의 진동 강도 표시 |
| 반응형 레이아웃 | 모바일 · 태블릿 · 데스크톱 지원 |

---

## 사용 방법

1. **X 모드 (m)** 슬라이더로 X 방향 진동 모드를 조절합니다.
2. **Y 모드 (n)** 슬라이더로 Y 방향 진동 모드를 조절합니다.
3. 모드가 바뀌면 입자들이 자동으로 새로운 노드 라인으로 이동합니다.
4. **입자 수** 슬라이더로 시뮬레이션 밀도를 조절합니다.
5. **리셋** 버튼을 눌러 입자를 무작위 위치로 되돌립니다.
6. **저장(PNG)** 버튼으로 현재 패턴을 이미지로 저장합니다.
7. 프리셋 버튼으로 원하는 패턴을 빠르게 선택하세요.

---

## 로컬 실행

별도의 빌드 도구 없이 정적 파일만으로 동작합니다.

```bash
# 저장소 클론
git clone https://github.com/deepest68/chladni-simulation.git
cd chladni-simulation

# 간단한 HTTP 서버 실행 (Python 3)
python -m http.server 8080

# 브라우저에서 접속
open http://localhost:8080
```

또는 VS Code의 **Live Server** 확장을 사용할 수 있습니다.

---

## 기술 스택

- **HTML5 Canvas API** — 실시간 2D 렌더링
- **Vanilla JavaScript (ES6+)** — 물리 시뮬레이션, 입자 시스템
- **CSS3** — 다크 모드 테마, 반응형 레이아웃, 커스텀 슬라이더

---

## 물리 원리

### 진동 방정식
2D 정현파 중첩으로 정사각형 평판의 진동 모드를 계산합니다.

```
z(x, y) = sin(m · π · x) · sin(n · π · y)
```

- **x, y** : 0~1 정규화 좌표
- **m, n** : 진동 모드 번호 (1~10)
- **z** : 해당 위치의 진동 진폭

### 입자 동역학
각 입자는 매 프레임마다:

1. 현재 위치에서 진동 진폭의 **기울기(gradient)** 를 계산합니다.
2. 기울기의 반대 방향(=진동이 약한 곳)으로 힘을 받습니다.
3. **감쇠(damping)** 를 적용해 노드 라인 위에서 안정됩니다.
4. 소량의 무작위 **노이즈** 로 패턴이 자연스럽게 보이도록 합니다.

```
vx = (vx - gx · FORCE_SCALE) · DAMPING + noise
vy = (vy - gy · FORCE_SCALE) · DAMPING + noise
```

### 최적화
- 진동 필드를 256×256 격자에 미리 계산하여 **캐싱**
- 이중선형 보간(bilinear interpolation)으로 부드러운 기울기 계산
- `requestAnimationFrame` 으로 60 FPS 렌더링
- 오프스크린 Canvas를 활용한 히트맵 렌더링

---

## 파일 구조

```
/
├── index.html       # 메인 HTML, UI 컨트롤
├── css/
│   └── style.css   # 다크 모드 테마, 반응형 스타일
├── js/
│   └── chladni.js  # 시뮬레이션 엔진
└── README.md
```

---

## 라이선스

MIT License
