import * as cheerio from 'cheerio';
import ky from 'ky';

// 型定義
export interface StickerData {
	type: string;
	id: string;
	staticUrl: string;
	fallbackStaticUrl: string;
	animationUrl: string;
	popupUrl: string;
	soundUrl: string;
}

export interface StickerPack {
	title: string;
	author: string;
	stickers: StickerData[];
}

const client = ky.create({
	prefixUrl: 'https://store.line.me/',
	headers: {
		accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
		'accept-language': 'ja',
		'cache-control': 'no-cache',
		pragma: 'no-cache',
		priority: 'u=0, i',
		'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'sec-fetch-dest': 'document',
		'sec-fetch-mode': 'navigate',
		'sec-fetch-site': 'none',
		'sec-fetch-user': '?1',
		'upgrade-insecure-requests': '1',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
	}
});

export async function fetchStickerPack(packId: number): Promise<StickerPack> {
	try {
		const response = await client.get(`stickershop/product/${packId}/ja`);
		const text = await response.text();
		const $ = cheerio.load(text);

		const stickerNameTitle = $('p[data-test="sticker-name-title"]').text().trim();
		const stickerAuthor = $('a[data-test="sticker-author"]').text().trim();

		const stickerItems = $('li[data-test="sticker-item"]');
		const stickers: StickerData[] = [];

		stickerItems.each((_, el) => {
			const $el = $(el);
			const dataPreview = $el.attr('data-preview');
			if (!dataPreview) return;

			try {
				const previewData: StickerData = JSON.parse(dataPreview);
				stickers.push(previewData);
			} catch (error) {
				console.error('スタンプデータのパースに失敗:', error);
			}
		});

		return {
			title: stickerNameTitle || 'Unknown Sticker Pack',
			author: stickerAuthor || 'Unknown Author',
			stickers
		};
	} catch (error) {
		console.error('スタンプパックの取得に失敗:', error);
		throw new Error(`スタンプパック ${packId} の取得に失敗しました`);
	}
}
