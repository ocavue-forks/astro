declare module 'astro:preact:opts' {
	const opts: {
		include: import('@preact/preset-vite').PreactPluginOptions['include'] | null;
		exclude: import('@preact/preset-vite').PreactPluginOptions['exclude'] | null;
	};
	export default opts;
}
