import * as fs from 'fs';
import * as crypto from 'crypto';
import * as openpgp from 'openpgp';
import * as denodeify from 'denodeify';
import { IFile, IInMemoryFile, isInMemoryFile, unzip, log, read } from './util';

const readFile = denodeify<string, string, string>(fs.readFile);

export type Path = string;
export type Checksum = string;
export type ChecksumMap = Map<Path, Checksum>;

async function checksumFile(file: IFile): Promise<Checksum> {
	const hash = crypto.createHash('sha256');

	if (isInMemoryFile(file)) {
		hash.write(file.contents);
		return hash.digest('base64');
	} else {
		return await new Promise((c, e) => {
			const stream = fs.createReadStream(file.localPath);

			stream
				.pipe(hash)
				.on('error', err => e(err))
				.on('data', (data: Buffer) => c(data.toString('base64')));
		});
	}
}

export async function createChecksumMap(files: IFile[]): Promise<ChecksumMap> {
	const result: ChecksumMap = new Map();

	for (const file of files) {
		result.set(file.path, await checksumFile(file));
	}

	return result;
}

export async function createChecksumFile(files: IFile[]): Promise<IInMemoryFile> {
	const checksumMap = await createChecksumMap(files);
	const lines: string[] = [];

	for (const [path, checksum] of checksumMap) {
		lines.push(`${checksum} ${path}\n`);
	}

	return { path: 'checksum', contents: lines.join('') };
}

export async function signChecksumFile(checksum: IInMemoryFile, privateKeyFile: string): Promise<IInMemoryFile> {
	const privateKeyArmored = await readFile(privateKeyFile, 'utf8');
	const passphrase = await read('Private key passphrase:', { silent: true, replace: '*' });
	const {
		keys: [privateKey],
	} = await openpgp.key.readArmored(privateKeyArmored);
	await privateKey.decrypt(passphrase);

	const { signature: detachedSignature } = await openpgp.sign({
		message: openpgp.cleartext.fromText(checksum.contents as string),
		privateKeys: [privateKey],
		detached: true,
	});

	return { path: 'checksum.sig', contents: detachedSignature };
}

function parseChecksumMap(buffer: Buffer): ChecksumMap {
	const result: ChecksumMap = new Map();
	const raw = buffer.toString('utf8');
	let index = 0;

	while (true) {
		const start = index;
		index = raw.indexOf('\n', start + 1);

		if (index === -1) {
			break;
		}

		if (raw[start + 44] !== ' ') {
			throw new Error('Invalid checksum file');
		}

		const checksum = raw.substr(start, 44);
		const name = raw.substring(start + 45, index);
		result.set(name, checksum);

		index += 1;
	}

	return result;
}

export interface IVerifyOptions {
	readonly signature?: string;
}

export async function verifyCommand(packagePath: string, opts: IVerifyOptions): Promise<void> {
	const files: IInMemoryFile[] = [];
	let checksum: Buffer | undefined;
	let expectedChecksumMap: ChecksumMap | undefined;
	let signature: Buffer | undefined;

	await unzip(packagePath, file => {
		if (/^checksum$/i.test(file.path)) {
			checksum = file.contents as Buffer;
			expectedChecksumMap = parseChecksumMap(checksum);
		} else if (/^checksum.sig$/i.test(file.path)) {
			signature = file.contents as Buffer;
		} else {
			files.push(file);
		}
	});

	if (!expectedChecksumMap) {
		throw new Error('Checksum file not found');
	}

	const actualChecksumMap = await createChecksumMap(files);

	// Verification
	const mismatched: string[] = [];
	const missing: string[] = [];
	const unexpected: string[] = [];

	for (const [path, checksum] of expectedChecksumMap) {
		const actualChecksum = actualChecksumMap.get(path);

		if (!actualChecksum) {
			missing.push(path);
		} else if (actualChecksum !== checksum) {
			mismatched.push(path);
		}
	}

	for (const [path] of actualChecksumMap) {
		if (!expectedChecksumMap.has(path)) {
			unexpected.push(path);
		}
	}

	const errorMessages: string[] = [];

	if (mismatched.length > 0) {
		errorMessages.push(`The following files are corrupt:\n${mismatched.map(name => `  ${name}`).join('\n')}`);
	}

	if (missing.length > 0) {
		errorMessages.push(`The following files are missing:\n${missing.map(name => `  ${name}`).join('\n')}`);
	}

	if (unexpected.length > 0) {
		errorMessages.push(`The following files are unexpected:\n${unexpected.map(name => `  ${name}`).join('\n')}`);
	}

	if (errorMessages.length) {
		throw new Error(`Validation failed\n\n${errorMessages.join('\n\n')}`);
	}

	if (!opts.signature) {
		if (signature) {
			log.warn(`Extension signature found but not verified. Provide --signature <publickey> to verify the signature.`);
		}

		log.done(`Extension checksum is valid: ${packagePath} (${files.length} files)`);
		return;
	}

	if (opts.signature && !signature) {
		throw new Error(`Extension is not signed.`);
	}

	const publicKey = await readFile(opts.signature, 'utf8');

	const verified = await openpgp.verify({
		message: openpgp.cleartext.fromText(checksum.toString('utf8')),
		signature: await openpgp.signature.readArmored(signature.toString('utf8')),
		publicKeys: (await openpgp.key.readArmored(publicKey)).keys,
	});

	const { valid } = verified.signatures[0];

	if (!valid) {
		throw new Error(`Signature invalid. Couldn't verify the signature against the provided public key.`);
	}

	log.done(`Extension signature is valid: ${packagePath} (${files.length} files)`);
}
