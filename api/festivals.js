// 서울(icn1) 리전에서 실행되어, 공공데이터포털 TourAPI를 대신 호출해주는 프록시 함수.
// GitHub Actions(해외 서버)가 apis.data.go.kr에 직접 접속하면 차단당하는 문제를
// 우회하기 위해, 한국 위치인 이 함수가 대신 호출하고 결과만 돌려준다.
//
// ?mode=nature 를 붙이면 축제(searchFestival2) 대신 자연관광지(areaBasedList2 +
// 자연관광지 카테고리)를 조회한다 — 수목원·공원·자연휴양림 지도용으로 추가됨.
// ?mode=shelter 를 붙이면 행정안전부 전국무더위쉼터표준데이터를 조회한다.
// (같은 공공데이터포털 계정의 서비스키를 그대로 재사용— 별도 키 발급 불필요)

const FESTIVAL_URL = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';
const AREA_LIST_URL = 'https://apis.data.go.kr/B551011/KorService2/areaBasedList2';
const SHELTER_URL = 'https://apis.data.go.kr/1741000/HeatWaveShelter3/getHeatWaveShelterList3';

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// [FIX] 페이지 하나를 가져오다 순간적으로 연결이 실패해도(네트워크 순단 등),
// 전체를 처음부터 다시 시도하지 않고 그 페이지만 짧게 재시도하도록 분리.
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  const apiKey = process.env.TOUR_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TOUR_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const modeParam = req.query.mode;
  const mode = modeParam === 'nature' ? 'nature' : (modeParam === 'shelter' ? 'shelter' : 'festival');

  const allItems = [];
  let pageNo = 1;
  const numOfRows = mode === 'festival' ? 200 : 100;

  try {
    while (true) {
      const baseUrl = mode === 'nature' ? AREA_LIST_URL : (mode === 'shelter' ? SHELTER_URL : FESTIVAL_URL);
      const url = new URL(baseUrl);
      url.searchParams.set('serviceKey', apiKey);
      url.searchParams.set('numOfRows', String(numOfRows));
      url.searchParams.set('pageNo', String(pageNo));
      url.searchParams.set('type', 'json');
      url.searchParams.set('_type', 'json');
      if (mode !== 'shelter') {
        url.searchParams.set('MobileOS', 'ETC');
        url.searchParams.set('MobileApp', 'hohoplay');
        url.searchParams.set('arrange', 'A');
      }

      if (mode === 'nature') {
        // 자연관광지: 국립/도립/군립공원, 자연휴양림, 수목원
        url.searchParams.set('contentTypeId', '12');
        url.searchParams.set('cat1', 'A01');
        url.searchParams.set('cat2', 'A0101');
      } else if (mode === 'festival') {
        let eventStartDate = req.query.from;
        if (!eventStartDate) {
          const from = new Date();
          from.setDate(from.getDate() - 30);
          eventStartDate = formatDate(from);
        }
        url.searchParams.set('eventStartDate', eventStartDate);
      }
      // mode === 'shelter'는 추가 파라미터 없이 전국 전체를 페이지 단위로 조회

      const response = await fetchWithRetry(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      }, 2);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`TourAPI HTTP ${response.status} | ${bodyText.slice(0, 200)}`);
      }

      const data = await response.json();
      const header = data?.response?.header;
      if (!header || (header.resultCode !== '0000' && header.resultCode !== '00')) {
        throw new Error(`TourAPI 오류 응답: ${header?.resultMsg || '알 수 없음'}`);
      }

      const body = data?.response?.body;
      const totalCount = Number(body?.totalCount || 0);
      const items = body?.items;
      let itemList = [];
      if (items && items !== '') {
        itemList = Array.isArray(items.item) ? items.item : (items.item ? [items.item] : []);
      }
      allItems.push(...itemList);

      if (pageNo * numOfRows >= totalCount || itemList.length === 0) {
        break;
      }
      pageNo += 1;
    }

    res.status(200).json({ items: allItems, totalCount: allItems.length });
  } catch (err) {
    const causeDetail = err && err.cause
      ? ` | cause: ${err.cause.code || err.cause.message || String(err.cause)}`
      : '';
    const message = String(err && err.message ? err.message : err) + causeDetail;
    console.error(`festivals.js 오류 (mode=${mode}, pageNo=${pageNo}):`, message);
    res.status(502).json({ error: message });
  }
}
