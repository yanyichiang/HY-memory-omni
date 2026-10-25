/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Copyright (c) 2026 YY. Thin API bridge; decoding is unmodified FFmpeg.
 */
#include <stdlib.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavutil/samplefmt.h>
#include <libavutil/error.h>

typedef struct { AVCodecContext *ctx; AVPacket *packet; AVFrame *frame; float output[8192*2]; int channels; int rate; } Decoder;
Decoder *aac_create(const unsigned char *asc,int len){
 Decoder*d=calloc(1,sizeof(Decoder)); if(!d)return NULL;
 d->ctx=avcodec_alloc_context3(avcodec_find_decoder(AV_CODEC_ID_AAC));
 if(!d->ctx){free(d);return NULL;}
 d->ctx->err_recognition=AV_EF_EXPLODE|AV_EF_CRCCHECK;
 if(len){d->ctx->extradata=av_mallocz(len+AV_INPUT_BUFFER_PADDING_SIZE); if(!d->ctx->extradata){avcodec_free_context(&d->ctx);free(d);return NULL;}memcpy(d->ctx->extradata,asc,len);d->ctx->extradata_size=len;}
 if(avcodec_open2(d->ctx,avcodec_find_decoder(AV_CODEC_ID_AAC),NULL)<0){avcodec_free_context(&d->ctx);free(d);return NULL;}
 d->packet=av_packet_alloc();d->frame=av_frame_alloc();
 if(!d->packet||!d->frame){av_frame_free(&d->frame);av_packet_free(&d->packet);avcodec_free_context(&d->ctx);free(d);return NULL;}
 return d;
}
int aac_decode(Decoder*d,const unsigned char*buf,int len){
 int ret;av_packet_unref(d->packet); d->ctx->err_recognition=AV_EF_EXPLODE|AV_EF_CRCCHECK;
 if(len){ret=av_new_packet(d->packet,len);if(ret<0)return ret;memcpy(d->packet->data,buf,len);}
 ret=avcodec_send_packet(d->ctx,len?d->packet:NULL);if(ret<0)return ret;
 ret=avcodec_receive_frame(d->ctx,d->frame);if(ret==AVERROR(EAGAIN)||ret==AVERROR_EOF)return 0;if(ret<0)return ret;
 int channels=d->frame->ch_layout.nb_channels,n=d->frame->nb_samples;
 if(channels<1||channels>2||n>8192||d->frame->format!=AV_SAMPLE_FMT_FLTP)return -100001;
 d->channels=channels;d->rate=d->frame->sample_rate;
 for(int i=0;i<n;i++)for(int c=0;c<channels;c++)d->output[i*channels+c]=((float*)d->frame->extended_data[c])[i];
 av_frame_unref(d->frame);return n;
}
float*aac_output(Decoder*d){return d->output;}int aac_rate(Decoder*d){return d->rate;}int aac_channels(Decoder*d){return d->channels;}
void aac_free(Decoder*d){if(!d)return;av_frame_free(&d->frame);av_packet_free(&d->packet);avcodec_free_context(&d->ctx);free(d);}

int aac_profile(Decoder*d){return d->ctx->profile;}
