#include <stdlib.h>
#include <string.h>
#define H264E_SVC_API 0
#define H264E_MAX_THREADS 0
#define MINIH264_IMPLEMENTATION
#include "minih264e.h"
typedef struct { H264E_persist_t *state; void *scratch; unsigned char *pixels; int w,h; } Encoder;
Encoder* animation_create(int w,int h) {
 if(w<2||h<2||w%2||h%2||w>2048||h>2048||w*h>1048576)return 0;
 H264E_create_param_t p={0};p.width=w;p.height=h;p.gop=1;p.const_input_flag=1;
 int a,b;if(H264E_sizeof(&p,&a,&b)||a<=0||b<=0||a+b>32*1024*1024)return 0;
 Encoder* e=calloc(1,sizeof(Encoder));if(!e)return 0;
 e->state=malloc(a);e->scratch=malloc(b);e->pixels=malloc(w*h*3/2);e->w=w;e->h=h;
 if(!e->state||!e->scratch||!e->pixels||H264E_init(e->state,&p)){free(e->state);free(e->scratch);free(e->pixels);free(e);return 0;}return e;
}
unsigned char* animation_input(Encoder*e){return e?e->pixels:0;}
int animation_encode(Encoder*e,unsigned char**data) {
 if(!e||!data)return -1;
 H264E_io_yuv_t y={0};y.yuv[0]=e->pixels;y.yuv[1]=e->pixels+e->w*e->h;y.yuv[2]=y.yuv[1]+e->w*e->h/4;y.stride[0]=e->w;y.stride[1]=y.stride[2]=e->w/2;
 H264E_run_param_t p={0};p.encode_speed=H264E_SPEED_FASTEST;p.qp_min=p.qp_max=10;
 int length=0;int error=H264E_encode(e->state,e->scratch,&p,&y,data,&length);return error?-error:length;
}
void animation_free(Encoder*e){if(e){free(e->pixels);free(e->scratch);free(e->state);free(e);}}
