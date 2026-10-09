// [ADD] 2026-10-09
// 아이랑 나들이 지도(kids_places.json)의 199개 장소는 TourAPI 축제/자연관광지 피드가 아니라
// 직접 큐레이션한 목록이라 처음부터 사진이 없었다. 하지만 이 장소들 중 상당수(박물관·공원·
// 식물원 등)는 TourAPI의 관광지/문화시설 DB에도 똑같이 들어있을 가능성이 높으므로, 이름으로
// TourAPI를 "검색"해서 매칭되는 장소의 공식 사진(firstimage)을 가져오는 용도의 엔드포인트다.
//
// festivals.js(기존 프록시)를 건드리지 않고 같은 api/ 폴더에 새 파일로 추가하는 방식으로
// 만들었다 — 기존 파일의 정확한 내용을 이번 세션에서 받지 못해서, 그걸 고치는 대신 별도
// 엔드포인트를 새로 만들었다. 배포하면 https://<프로젝트>.vercel.app/api/kids-image-search
// 로 호출할 수 있다.
//
// 사용법 (scripts/fetch_kids_images.py가 이 모양으로 호출한다):
//   GET /api/kids-image-search?keyword=경포호%20둘레길
//   → { "items": [ { "title": "...", "addr1": "...", "firstimage": "...", "contentid": "..." }, ... ] }
//   → 검색 결과가 없거나 TourAPI 호출이 실패하면 { "items": [] } 또는 { "error": "..." }
//
// 설정해야 할 환경변수 (Vercel 프로젝트 설정 → Environment Variables):
//   TOUR_API_KEY : 공공데이터포털에서 발급받은 TourAPI(한국관광공사) 서비스 키(디코딩된 값)
//                  — festivals.js가 이미 TourAPI를 호출하고 있다면 그 안에서 쓰는 환경변수를
//                  그대로 재사용해도 된다. 이름이 다르면 아래 TOUR_API_KEY 부분만
//                  festivals.js와 같은 변수명으로 바꿔주면 됨.
//
// 주의: TourAPI 서비스키는 URL에 그대로 붙이면 안에 포함된 특수문자(+, /, = 등) 때문에
// 중복 인코딩 문제가 생기기 쉽다. 아래처럼 encodeURIComponent로 감싸지 않고 쿼리스트링에
// 직접 이어붙이는 방식(공공데이터포털이 흔히 안내하는 방식)을 썼다 — 이미 URL-encode된
// 키를 받았다면 그대로, 아니라면 발급받은 "Encoding" 키를 쓰는 걸 권장한다.

const TOUR_API_BASE = 'https://apis.data.go.kr/B551011/KorService2/searchKeyword2';

module.exports = async (req, res) => {
  const allowOrigin = 'https://hohoplaylab.com';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const keyword = (req.query.keyword || '').toString().trim();
  if (!keyword) {
    res.status(400).json({ error: 'keyword 쿼리 파라미터가 필요합니다.' });
    return;
  }

  const serviceKey = process.env.TOUR_API_KEY;
  if (!serviceKey) {
    res.status(500).json({ error: 'TOUR_API_KEY 환경변수가 설정되어 있지 않습니다.' });
    return;
  }

  const url =
    `${TOUR_API_BASE}?serviceKey=${serviceKey}` +
    `&MobileOS=ETC&MobileApp=hohoplaylab` +
    `&_type=json&numOfRows=5&pageNo=1&arrange=A` +
    `&keyword=${encodeURIComponent(keyword)}`;

  try {
    const apiRes = await fetch(url, { timeout: 15000 });
    const text = await apiRes.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      // TourAPI는 키 오류 등이 있으면 JSON이 아니라 XML 에러 문서를 돌려준다.
      res.status(502).json({ error: `TourAPI 응답이 JSON이 아님: ${text.slice(0, 200)}` });
      return;
    }

    const header = data && data.response && data.response.header;
    if (!header || header.resultCode !== '0000') {
      res.status(502).json({ error: `TourAPI 오류: ${header ? header.resultMsg : '알 수 없음'}` });
      return;
    }

    const rawItems = (data.response.body && data.response.body.items && data.response.body.items.item) || [];
    // TourAPI는 결과가 1건이면 배열이 아니라 객체 하나만 내려주는 경우가 있어 보정한다.
    const itemList = Array.isArray(rawItems) ? rawItems : [rawItems];

    const items = itemList
      .filter((it) => it && it.title)
      .map((it) => ({
        title: it.title || '',
        addr1: it.addr1 || '',
        addr2: it.addr2 || '',
        contentid: it.contentid || '',
        contenttypeid: it.contenttypeid || '',
        firstimage: it.firstimage || '',
        firstimage2: it.firstimage2 || '',
        mapx: it.mapx || '',
        mapy: it.mapy || '',
      }));

    res.status(200).json({ items });
  } catch (e) {
    res.status(502).json({ error: `TourAPI 호출 실패: ${e.message || e}` });
  }
};
