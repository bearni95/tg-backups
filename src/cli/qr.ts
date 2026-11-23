import qrcode from 'qrcode-generator';

/**
 * A QR code drawn with half blocks, two rows per line. Light modules are the
 * terminal's text colour, so it scans on the usual light-on-dark terminal.
 */
export function terminalQr(value: string): string {
	const code = qrcode(0, 'L');
	code.addData(value);
	code.make();
	return code.createASCII(1, 2);
}
