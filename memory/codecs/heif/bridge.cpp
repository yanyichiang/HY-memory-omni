// Copyright 2026 YY. Isolated prototype; not a production image API.
#include <libheif/heif.h>
#include <libheif/heif_sequences.h>
#include <libheif/heif_security.h>
#include <libheif/heif_tiling.h>
#include <libheif/heif_properties.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <algorithm>

static constexpr uint64_t PIXELS = 8000000;
static constexpr int SIDE = 8192, ITEMS = 256, FRAMES = 256, TRACKS = 8;
static char error_text[512] = {};
static int error(const char* message) {
  std::snprintf(error_text, sizeof(error_text), "%s", message ? message : "image_error");
  return -1;
}
static int checked(heif_error e) {
  if (e.code == heif_error_Ok) return 1;
  std::snprintf(error_text, sizeof(error_text), "%d/%d: %s", e.code, e.subcode, e.message ? e.message : "image_error");
  return -1;
}
struct HyProbeImageDecoder {
  heif_context* ctx = nullptr;
  heif_image_handle* item = nullptr;
  heif_track* track = nullptr;
  heif_image* image = nullptr;
  heif_decoding_options* options = nullptr;
  heif_item_id ids[ITEMS] = {};
  uint32_t tracks[TRACKS] = {};
  int count = 0, track_count = 0, kind = 0, selected = 0, decoded = 0;
  bool visual_sequence = false;
  int width = 0, height = 0, stride = 0, source_depth = 0;
  uint32_t primary = 0, rate = 0, repetitions = 1;
  uint64_t duration = 0;
  const uint8_t* plane = nullptr;
  bool selected_item_read = false;
  heif_item_id selected_id = 0;
  ~HyProbeImageDecoder() {
    if (image) heif_image_release(image);
    if (item) heif_image_handle_release(item);
    if (track) heif_track_release(track);
    if (options) heif_decoding_options_free(options);
    if (ctx) heif_context_free(ctx);
  }
};
static bool dimensions(int width, int height) {
  return width > 0 && height > 0 && width <= SIDE && height <= SIDE
      && uint64_t(width) * uint64_t(height) <= PIXELS;
}
// Large static images are admitted only as independent opaque SDR tiles.
// Header geometry and destination are bounded separately from decoded tile size.
static bool large_grid(heif_context* ctx, heif_image_handle* h, heif_item_id id) {
  const int w=heif_image_handle_get_width(h),height=heif_image_handle_get_height(h);
  if(w<=0 || height<=0 || w>SIDE || height>SIDE || uint64_t(w)*height>16000000
      || heif_image_handle_has_alpha_channel(h) || heif_image_handle_get_luma_bits_per_pixel(h)!=8
      || heif_image_handle_get_raw_color_profile_size(h)!=0
      || heif_item_get_transformation_properties(ctx,id,nullptr,0)!=0) return false;
  heif_color_profile_nclx* profile=nullptr;
  auto color=heif_image_handle_get_nclx_color_profile(h,&profile);
  if(color.code==heif_error_Ok && profile) {
    bool sdr=profile->transfer_characteristics==1 || profile->transfer_characteristics==2
        || profile->transfer_characteristics==6 || profile->transfer_characteristics==13;
    heif_nclx_color_profile_free(profile);if(!sdr)return false;
  }
  heif_image_tiling t{};t.version=1;
  auto e=heif_image_handle_get_image_tiling(h,1,&t);
  const bool geometry=e.code==heif_error_Ok && t.num_columns && t.num_rows
      && uint64_t(t.num_columns)*t.num_rows>1 && uint64_t(t.num_columns)*t.num_rows<=256
      && t.tile_width && t.tile_height && uint64_t(t.tile_width)*t.tile_height<=262144
      && t.image_width==uint32_t(w) && t.image_height==uint32_t(height)
      && uint64_t(t.tile_width)*t.num_columns>=uint32_t(w)
      && uint64_t(t.tile_height)*t.num_rows>=uint32_t(height)
      && uint64_t(t.tile_width)*(t.num_columns-1)<uint32_t(w)
      && uint64_t(t.tile_height)*(t.num_rows-1)<uint32_t(height)
      && !t.left_offset && !t.top_offset && !t.number_of_extra_dimensions;
  if(!geometry)return false;
  for(uint32_t row=0;row<t.num_rows;row++)for(uint32_t col=0;col<t.num_columns;col++) {
    heif_item_id leaf_id=0;heif_image_handle* leaf=nullptr;
    if(heif_image_handle_get_grid_image_tile_id(h,1,col,row,&leaf_id).code!=heif_error_Ok
        || heif_context_get_image_handle(ctx,leaf_id,&leaf).code!=heif_error_Ok)return false;
    const int lw=heif_image_handle_get_width(leaf),lh=heif_image_handle_get_height(leaf);
    const bool valid=lw>0 && lh>0 && uint64_t(lw)*lh<=262144
        && !heif_image_handle_has_alpha_channel(leaf)
        && heif_image_handle_get_luma_bits_per_pixel(leaf)==8
        && !heif_image_handle_get_raw_color_profile_size(leaf)
        && !heif_item_get_transformation_properties(ctx,leaf_id,nullptr,0);
    heif_color_profile_nclx* leaf_profile=nullptr;
    auto leaf_color=heif_image_handle_get_nclx_color_profile(leaf,&leaf_profile);
    bool leaf_sdr=true;
    if(leaf_color.code==heif_error_Ok && leaf_profile){
      const auto transfer=leaf_profile->transfer_characteristics;
      leaf_sdr=transfer==1 || transfer==2 || transfer==6 || transfer==13;
      heif_nclx_color_profile_free(leaf_profile);
    }
    heif_image_handle_release(leaf);if(!valid || !leaf_sdr)return false;
  }
  return true;
}
extern "C" {
const char* img_error() { return error_text; }
void img_close(HyProbeImageDecoder* d) { delete d; }
HyProbeImageDecoder* img_open(const uint8_t* data, uint32_t length) {
  error_text[0] = 0;
  if (!data || !length || length > 8 * 1024 * 1024) { error("input_limit"); return nullptr; }
  auto* d = new(std::nothrow) HyProbeImageDecoder();
  if (!d) { error("allocation_failed"); return nullptr; }
  d->ctx = heif_context_alloc();
  if (!d->ctx) { delete d; error("allocation_failed"); return nullptr; }
  auto* limit = heif_context_get_security_limits(d->ctx);
  limit->max_image_size_pixels = 16000000; // Header budget; large items require proven tile route below.
  limit->max_number_of_tiles = 256;
  limit->max_items = ITEMS;
  limit->max_color_profile_size = 1024 * 1024;
  limit->max_memory_block_size = 40 * 1024 * 1024;
  limit->max_total_memory = 48 * 1024 * 1024;
  limit->max_children_per_box = 1024;
  limit->max_iloc_extents_per_item = 256;
  limit->max_sequence_frames = FRAMES;
  limit->max_sample_description_box_entries = 8;
  limit->max_sample_group_description_box_entries = 256;
  limit->max_number_of_file_brands = 32;
  heif_context_set_max_decoding_threads(d->ctx, 0);
  if (checked(heif_context_read_from_memory_without_copy(d->ctx, data, length, nullptr)) < 0) { delete d; return nullptr; }
  d->count = heif_context_get_number_of_top_level_images(d->ctx);
  d->track_count = heif_context_number_of_sequence_tracks(d->ctx);
  if (d->count < 0 || d->count > ITEMS || d->track_count < 0 || d->track_count > TRACKS
      || (d->count == 0 && d->track_count == 0)) { error("item_or_track_limit"); delete d; return nullptr; }
  if (d->count) {
    if (heif_context_get_list_of_top_level_image_IDs(d->ctx, d->ids, d->count) != d->count
        || checked(heif_context_get_primary_image_ID(d->ctx, &d->primary)) < 0) { delete d; return nullptr; }
    for (int i = 0; i < d->count; i++) {
      heif_image_handle* h = nullptr;
      if (checked(heif_context_get_image_handle(d->ctx, d->ids[i], &h)) < 0) { delete d; return nullptr; }
      const bool valid = dimensions(heif_image_handle_get_width(h), heif_image_handle_get_height(h))
          || large_grid(d->ctx,h,d->ids[i]);
      heif_image_handle_release(h);
      if (!valid) { error("dimensions_limit_or_large_grid_unsupported"); delete d; return nullptr; }
    }
  }
  if (d->track_count) {
    heif_context_get_track_ids(d->ctx, d->tracks);
    for (int i = 0; i < d->track_count; i++) {
      auto* track = heif_context_get_track(d->ctx, d->tracks[i]);
      if (!track) { error("track_invalid"); delete d; return nullptr; }
      const auto type = heif_track_get_track_handler_type(track);
      if (type == heif_track_type_image_sequence || type == heif_track_type_video) {
        d->visual_sequence = true;
        uint16_t w = 0, h = 0;
        const auto e = heif_track_get_image_resolution(track, &w, &h);
        const bool valid = checked(e) > 0 && dimensions(w, h) && heif_track_get_timescale(track) > 0;
        heif_track_release(track);
        if (!valid) { error("sequence_dimensions_or_clock_invalid"); delete d; return nullptr; }
      } else { heif_track_release(track); }
    }
  }
  d->kind = d->visual_sequence ? 3 : d->count > 1 ? 2 : 1;
  d->options = heif_decoding_options_alloc();
  if (!d->options) { error("allocation_failed"); delete d; return nullptr; }
  d->options->ignore_transformations = 0;
  d->options->strict_decoding = 1;
  d->options->convert_hdr_to_8bit = 1;
  d->options->ignore_sequence_editlist = 1; // Read one media cycle; expose repetitions separately.
  d->options->num_library_threads = 1;
  d->options->num_codec_threads = 1;
  d->options->output_image_nclx_profile_passthrough = 0; // RGBA8 sRGB target; not HDR preservation.
  return d;
}
int img_kind(HyProbeImageDecoder* d) { return d ? d->kind : 0; }
int img_count(HyProbeImageDecoder* d) { return d ? d->count : 0; }
uint32_t img_item_id(HyProbeImageDecoder* d, int i) { return d && i >= 0 && i < d->count ? d->ids[i] : 0; }
int img_item_width(HyProbeImageDecoder* d, int i) {
  if (!d || i < 0 || i >= d->count) return 0;
  heif_image_handle* h = nullptr;
  if (checked(heif_context_get_image_handle(d->ctx, d->ids[i], &h)) < 0) return 0;
  const int w = heif_image_handle_get_width(h); heif_image_handle_release(h); return w;
}
int img_item_height(HyProbeImageDecoder* d, int i) {
  if (!d || i < 0 || i >= d->count) return 0;
  heif_image_handle* h = nullptr;
  if (checked(heif_context_get_image_handle(d->ctx, d->ids[i], &h)) < 0) return 0;
  const int hgt = heif_image_handle_get_height(h); heif_image_handle_release(h); return hgt;
}
uint32_t img_primary(HyProbeImageDecoder* d) { return d ? d->primary : 0; }
int img_track_count(HyProbeImageDecoder* d) { return d ? d->track_count : 0; }
uint32_t img_track_id(HyProbeImageDecoder* d, int i) { return d && i >= 0 && i < d->track_count ? d->tracks[i] : 0; }
uint32_t img_track_type(HyProbeImageDecoder* d, int i) {
  if (!d || i < 0 || i >= d->track_count) return 0;
  auto* t = heif_context_get_track(d->ctx, d->tracks[i]);
  if (!t) return 0;
  const uint32_t type = heif_track_get_track_handler_type(t); heif_track_release(t); return type;
}
int img_select(HyProbeImageDecoder* d, int kind, int index) {
  if (!d || d->selected) return error("select_once_per_context");
  if (kind == 1 && index >= 0 && index < d->count) {
    if (checked(heif_context_get_image_handle(d->ctx, d->ids[index], &d->item)) < 0) return -1;
    d->selected = 1; d->selected_id = d->ids[index];
    d->source_depth = heif_image_handle_get_luma_bits_per_pixel(d->item);
    return 1;
  }
  if (kind == 2 && index >= 0 && index < d->track_count) {
    d->track = heif_context_get_track(d->ctx, d->tracks[index]);
    if (!d->track) return error("track_invalid");
    const auto type = heif_track_get_track_handler_type(d->track);
    if (type != heif_track_type_image_sequence && type != heif_track_type_video) return error("nonvisual_track");
    d->rate = heif_track_get_timescale(d->track);
    d->repetitions = heif_track_get_number_of_repetitions(d->track);
    if (!d->rate || !d->repetitions) return error("uninterpreted_editlist");
    d->selected = 2;
    return 1;
  }
  return error("selection_invalid");
}
int img_next(HyProbeImageDecoder* d) {
  if (!d || !d->selected) return error("selection_required");
  if (d->image) { heif_image_release(d->image); d->image = nullptr; }
  d->plane = nullptr;
  if (d->selected == 1 && d->selected_item_read) return 0;
  heif_error e;
  if (d->selected == 1) {
    if (!dimensions(heif_image_handle_get_width(d->item),heif_image_handle_get_height(d->item))) {
      if(!large_grid(d->ctx,d->item,d->selected_id))return error("large_grid_unsupported");
      heif_image_tiling tiling{};tiling.version=1;
      e=heif_image_handle_get_image_tiling(d->item,1,&tiling);
      if(checked(e)<0)return -1;
      uint32_t factor=1,ow=tiling.image_width,oh=tiling.image_height;
      while(uint64_t(ow)*oh>4000000) {
        ++factor;ow=(tiling.image_width+factor-1)/factor;oh=(tiling.image_height+factor-1)/factor;
      }
      e=heif_image_create(ow,oh,heif_colorspace_RGB,heif_chroma_interleaved_RGBA,&d->image);
      if(checked(e)<0)return -1;
      e=heif_image_add_plane(d->image,heif_channel_interleaved,ow,oh,8);
      if(checked(e)<0)return -1;
      int output_stride=0;
      auto* output=heif_image_get_plane(d->image,heif_channel_interleaved,&output_stride);
      if(!output || output_stride<int(ow*4))return error("plane_invalid");
      for(uint32_t row=0;row<tiling.num_rows;row++) for(uint32_t col=0;col<tiling.num_columns;col++) {
        heif_image* tile=nullptr;
        e=heif_image_handle_decode_image_tile(d->item,&tile,heif_colorspace_RGB,heif_chroma_interleaved_RGBA,d->options,col,row);
        if(checked(e)<0){if(tile)heif_image_release(tile);return -1;}
        int stride=0;const auto* pixels=heif_image_get_plane_readonly(tile,heif_channel_interleaved,&stride);
        const uint32_t tw=heif_image_get_primary_width(tile),th=heif_image_get_primary_height(tile);
        const uint32_t ox=col*tiling.tile_width,oy=row*tiling.tile_height;
        const uint32_t ex=std::min(ox+tiling.tile_width,tiling.image_width),ey=std::min(oy+tiling.tile_height,tiling.image_height);
        if(!pixels || tw<ex-ox || th<ey-oy || uint64_t(tw)*th>262144 || stride<int(tw*4)) {
          heif_image_release(tile);return error("tile_geometry_invalid");
        }
        for(uint32_t y=(oy+factor-1)/factor;y<(ey+factor-1)/factor;y++)
          for(uint32_t x=(ox+factor-1)/factor;x<(ex+factor-1)/factor;x++)
            std::memcpy(output+y*output_stride+x*4,pixels+(y*factor-oy)*stride+(x*factor-ox)*4,4);
        heif_image_release(tile);
      }
      e={heif_error_Ok,heif_suberror_Unspecified,"ok"};
    } else { e = heif_decode_image(d->item, &d->image, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, d->options); }
    d->selected_item_read = true;
  } else {
    e = heif_track_decode_next_image(d->track, &d->image, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, d->options);
    if (e.code == heif_error_End_of_sequence) return 0;
  }
  if (checked(e) < 0) return -1;
  if (++d->decoded > FRAMES) return error("frame_limit");
  d->width = heif_image_get_primary_width(d->image);
  d->height = heif_image_get_primary_height(d->image);
  if (!dimensions(d->width, d->height)) return error("dimensions_limit");
  d->plane = heif_image_get_plane_readonly(d->image, heif_channel_interleaved, &d->stride);
  if (!d->plane || d->stride < d->width * 4) return error("plane_invalid");
  d->duration = d->selected == 2 ? heif_image_get_duration(d->image) : 0;
  return 1;
}
int img_width(HyProbeImageDecoder* d) { return d ? d->width : 0; }
int img_height(HyProbeImageDecoder* d) { return d ? d->height : 0; }
const uint8_t* img_plane(HyProbeImageDecoder* d) { return d ? d->plane : nullptr; }
int img_stride(HyProbeImageDecoder* d) { return d ? d->stride : 0; }
uint32_t img_timescale(HyProbeImageDecoder* d) { return d ? d->rate : 0; }
uint64_t img_duration(HyProbeImageDecoder* d) { return d ? d->duration : 0; }
uint32_t img_repetitions(HyProbeImageDecoder* d) { return d ? d->repetitions : 0; }
int img_depth(HyProbeImageDecoder* d) { return d ? d->source_depth : 0; }
uint32_t img_icc_size(HyProbeImageDecoder* d) { return d && d->item ? heif_image_handle_get_raw_color_profile_size(d->item) : 0; }
int img_nclx_transfer(HyProbeImageDecoder* d) {
  if (!d || !d->image) return -1;
  heif_color_profile_nclx* profile = nullptr;
  const auto e = heif_image_get_nclx_color_profile(d->image, &profile);
  if (e.code != heif_error_Ok || !profile) return -1;
  int result = profile->transfer_characteristics; heif_nclx_color_profile_free(profile); return result;
}
int img_nclx_primaries(HyProbeImageDecoder* d) {
  if (!d || !d->image) return -1;
  heif_color_profile_nclx* profile = nullptr;
  const auto e = heif_image_get_nclx_color_profile(d->image, &profile);
  if (e.code != heif_error_Ok || !profile) return -1;
  int result = profile->color_primaries; heif_nclx_color_profile_free(profile); return result;
}
}
