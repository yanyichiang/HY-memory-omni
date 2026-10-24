import { prepareMp3 } from './prepare-mp3.mjs';
import { prepareAudioCodecs } from './prepare-audio-codecs.mjs';
import { prepareMatroska } from './prepare-matroska.mjs';

await prepareMp3();
await prepareAudioCodecs();
await prepareMatroska();
