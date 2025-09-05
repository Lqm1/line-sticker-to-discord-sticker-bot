import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { EmbedBuilder, type Guild, type Sticker } from 'discord.js';
import { fetchStickerPack, type StickerData, type StickerPack } from '../lib/line-store.js';

// 定数定義
const CONSTANTS = {
	MAX_DISCORD_STICKERS: 25,
	LINE_STORE_URL_REGEX: /https?:\/\/store\.line\.me\/stickershop\/product\/(\d+)\/?.*/,
	COLORS: {
		SUCCESS: 0x00ff00,
		ERROR: 0xff0000,
		WARNING: 0xffff00,
		INFO: 0x0099ff
	}
} as const;

interface StickerFile {
	attachment: Buffer;
	name: string;
}

@ApplyOptions<Command.Options>({
	description: 'LINEスタンプをDiscordスタンプに変換します。'
})
export class UserCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName(this.name)
				.setDescription(this.description)
				.setDMPermission(false)
				.addStringOption((option) => option.setName('url').setDescription('LINEスタンプのURLを入力してください。').setRequired(true))
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
		try {
			const url = interaction.options.getString('url', true);

			// URL検証
			const packId = this.validateAndExtractPackId(url);
			if (!packId) {
				await this.replyWithError(interaction, '無効なURLです', 'LINEスタンプのURLを入力してください。');
				return;
			}

			// ギルド検証
			if (!interaction.guild) {
				await this.replyWithError(interaction, 'サーバー限定コマンド', 'このコマンドはサーバー内でのみ使用できます。');
				return;
			}

			await interaction.deferReply();

			// スタンプパック取得
			const pack = await this.fetchStickerPackWithErrorHandling(packId, interaction);
			if (!pack) return;

			// スタンプ変換処理
			await this.convertAndCreateStickers(pack, interaction.guild, interaction);
		} catch (error) {
			console.error('スタンプ変換コマンドでエラーが発生しました:', error);
			const embed = this.createErrorEmbed('予期しないエラー', 'システムエラーが発生しました。しばらく時間をおいてから再度お試しください。');

			if (interaction.deferred) {
				await interaction.editReply({ embeds: [embed] });
			} else {
				await interaction.reply({ embeds: [embed], ephemeral: true });
			}
		}
	}

	/**
	 * URLを検証してパックIDを抽出
	 */
	private validateAndExtractPackId(url: string): number | null {
		const match = url.match(CONSTANTS.LINE_STORE_URL_REGEX);
		return match ? Number(match[1]) : null;
	}

	/**
	 * エラーハンドリング付きでスタンプパックを取得
	 */
	private async fetchStickerPackWithErrorHandling(packId: number, interaction: Command.ChatInputCommandInteraction): Promise<StickerPack | null> {
		try {
			const pack = await fetchStickerPack(packId);

			if (pack.stickers.length === 0) {
				const embed = this.createWarningEmbed(
					'スタンプが見つかりません',
					'このスタンプパックにはスタンプが含まれていないか、取得できませんでした。'
				);
				await interaction.editReply({ embeds: [embed] });
				return null;
			}

			return pack;
		} catch (error) {
			console.error('スタンプパック取得エラー:', error);
			const embed = this.createErrorEmbed('取得エラー', 'LINEスタンプの情報を取得できませんでした。URLが正しいか確認してください。');
			await interaction.editReply({ embeds: [embed] });
			return null;
		}
	}

	/**
	 * スタンプファイルをダウンロード
	 */
	private async downloadStickerFiles(stickers: StickerData[]): Promise<StickerFile[]> {
		const downloadPromises = stickers.map(async (sticker) => {
			try {
				const response = await fetch(sticker.animationUrl || sticker.staticUrl || sticker.fallbackStaticUrl);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}
				const buffer = await response.arrayBuffer();
				return {
					attachment: Buffer.from(buffer),
					name: `${sticker.id}.png`
				} as StickerFile;
			} catch (error) {
				console.error(`スタンプ ${sticker.id} のダウンロードに失敗:`, error);
				return null;
			}
		});

		const results = await Promise.all(downloadPromises);
		return results.filter((file): file is StickerFile => file !== null);
	}

	/**
	 * Discordスタンプを作成
	 */
	private async createDiscordStickers(guild: Guild, stickerFiles: StickerFile[], packTitle: string): Promise<Sticker[]> {
		const createdStickers: Sticker[] = [];

		for (const file of stickerFiles) {
			try {
				const sticker = await guild.stickers.create({
					file: file.attachment,
					name: `sticker_${file.name.split('.')[0]}`,
					description: packTitle.slice(0, 100), // Discord制限: 100文字
					tags: this.generateStickerTags(packTitle)
				});

				if (sticker) {
					createdStickers.push(sticker);
				}
			} catch (error) {
				console.error(`スタンプ ${file.name} の作成に失敗:`, error);
			}
		}

		return createdStickers;
	}

	/**
	 * スタンプタグを生成
	 */
	private generateStickerTags(title: string): string {
		// Discord制限: 200文字まで
		const cleanTitle = title.replace(/[^\w\s]/g, '').slice(0, 190);
		return cleanTitle || 'sticker';
	}

	/**
	 * スタンプ変換のメイン処理
	 */
	private async convertAndCreateStickers(pack: StickerPack, guild: Guild, interaction: Command.ChatInputCommandInteraction): Promise<void> {
		const stickersToProcess = pack.stickers.slice(0, CONSTANTS.MAX_DISCORD_STICKERS);

		// 処理開始通知
		const processingEmbed = this.createInfoEmbed(
			'処理中...',
			`${pack.title} から ${stickersToProcess.length} 個のスタンプを変換しています。\n作成者: ${pack.author}`
		);
		await interaction.editReply({ embeds: [processingEmbed] });

		// ダウンロード
		const stickerFiles = await this.downloadStickerFiles(stickersToProcess);

		if (stickerFiles.length === 0) {
			const embed = this.createErrorEmbed('ダウンロードエラー', 'スタンプファイルのダウンロードに失敗しました。');
			await interaction.editReply({ embeds: [embed] });
			return;
		}

		// Discord スタンプ作成
		const createdStickers = await this.createDiscordStickers(guild, stickerFiles, pack.title);

		// 結果報告
		if (createdStickers.length === 0) {
			const embed = this.createErrorEmbed('作成失敗', 'スタンプの作成に失敗しました。サーバーの権限を確認してください。');
			await interaction.editReply({ embeds: [embed] });
			return;
		}

		const embed = this.createSuccessEmbed(pack, createdStickers, stickerFiles.length);
		await interaction.editReply({ embeds: [embed] });
	}

	/**
	 * エラーメッセージ用のEmbed作成
	 */
	private createErrorEmbed(title: string, description: string): EmbedBuilder {
		return new EmbedBuilder().setColor(CONSTANTS.COLORS.ERROR).setTitle(`❌ ${title}`).setDescription(description).setTimestamp();
	}

	/**
	 * 警告メッセージ用のEmbed作成
	 */
	private createWarningEmbed(title: string, description: string): EmbedBuilder {
		return new EmbedBuilder().setColor(CONSTANTS.COLORS.WARNING).setTitle(`⚠️ ${title}`).setDescription(description).setTimestamp();
	}

	/**
	 * 情報メッセージ用のEmbed作成
	 */
	private createInfoEmbed(title: string, description: string): EmbedBuilder {
		return new EmbedBuilder().setColor(CONSTANTS.COLORS.INFO).setTitle(`ℹ️ ${title}`).setDescription(description).setTimestamp();
	}

	/**
	 * 成功メッセージ用のEmbed作成
	 */
	private createSuccessEmbed(pack: StickerPack, createdStickers: Sticker[], totalDownloaded: number): EmbedBuilder {
		const embed = new EmbedBuilder()
			.setColor(CONSTANTS.COLORS.SUCCESS)
			.setTitle('✅ スタンプ変換完了')
			.setDescription(`**${pack.title}** のスタンプをDiscordスタンプに変換しました！`)
			.addFields(
				{ name: '📦 パック名', value: pack.title, inline: true },
				{ name: '👨‍🎨 作成者', value: pack.author, inline: true },
				{ name: '📊 変換結果', value: `${createdStickers.length}/${totalDownloaded} 個作成成功`, inline: true }
			)
			.setTimestamp();

		// 作成されたスタンプ一覧（最大10個まで表示）
		if (createdStickers.length > 0) {
			const stickerList = createdStickers
				.slice(0, 10)
				.map((sticker, index) => `${index + 1}. ${sticker.name}`)
				.join('\n');

			const listValue =
				createdStickers.length > 10 ? `${stickerList}\n... および ${createdStickers.length - 10} 個の追加スタンプ` : stickerList;

			embed.addFields({ name: '📝 作成されたスタンプ', value: listValue, inline: false });
		}

		return embed;
	}

	/**
	 * エラー応答用のヘルパー
	 */
	private replyWithError(interaction: Command.ChatInputCommandInteraction, title: string, description: string) {
		const embed = this.createErrorEmbed(title, description);
		return interaction.reply({ embeds: [embed], ephemeral: true });
	}
}
