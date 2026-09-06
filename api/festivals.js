// 서울(icn1) 리전에서 실행되어, 공공데이터포털 TourAPI를 대신 호출해주는 프록시 함수.
// GitHub Actions(해외 서버)가 apis.data.go.kr에 직접 접속하면 차단당하는 문제를
// 우회하기 위해, 한국 위치인 이 함수가 대신 호출하고 결과만 돌려준다.

const BASE_URL = 'https://apis.data.go.kr/B551011/KorService2/searchFestival2';

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export default async function handler(req, res) {
  const apiKey = process.env.TOUR_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TOUR_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  // ?from=20260805 형태로 넘기면 그 날짜부터, 안 넘기면 30일 전부터 조회
  let eventStartDate = req.query.from;
  if (!eventStartDate) {
    const from = new Date();
    from.setDate(from.getDate() - 30);
    eventStartDate = formatDate(from);
  }

  const allItems = [];
  let pageNo = 1;
  const numOfRows = 200;

  try {
    while (true) {
      const url = new URL(BASE_URL);
      url.searchParams.set('serviceKey', apiKey);
      url.searchParams.set('numOfRows', String(numOfRows));
      url.searchParams.set('pageNo', String(pageNo));
      url.searchParams.set('MobileOS', 'ETC');
      url.searchParams.set('MobileApp', 'hohoplay');
      url.searchParams.set('_type', 'json');
      url.searchParams.set('eventStartDate', eventStartDate);
      url.searchParams.set('arrange', 'A');

      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                        + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });

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
    // [FIX] fetch() 자체가 실패하면(네트워크 단계 실패) err.message는 "fetch failed"처럼
    // 뭉뚱그려진 값만 담고 있고, 실제 원인(DNS 실패/타임아웃/연결거부 등)은 err.cause에
    // 따로 들어있다. 기존 코드는 이 cause를 안 읽어서 진짜 원인을 알 수 없었다.
    const causeDetail = err && err.cause
      ? ` | cause: ${err.cause.code || err.cause.message || String(err.cause)}`
      : '';
    const message = String(err && err.message ? err.message : err) + causeDetail;
    console.error('festivals.js 오류 (pageNo=' + pageNo + '):', message);
    res.status(502).json({ error: message });
  }
}
